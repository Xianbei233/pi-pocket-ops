/**
 * Explicit batch mutation for ops_write and ops_edit: strict input limits, a durable per-file journal, and a
 * per-file result. Ops asks for no separate approval; the normal host hooks (beforeTool, plan mode) still run.
 * It never replaces the native write/edit tools.
 */

import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { fail, OpsError, safeErrorMessage } from "./errors.ts";
import {
    buildMutationPlan,
    checkMutationText,
    closeMutationPlan,
    executeMutationPlan,
    revalidateMutationPlan,
    rollbackMutationPlan,
    type MutationFileInput,
    type MutationPlan,
} from "./mutation-io-v040.ts";
import { combineSignals } from "./scope.ts";
import type { Config, Scope } from "./types.ts";

export type MutationTool = "ops_write" | "ops_edit";

const MAX_PATH_CHARS = 4_096;
const MAX_FILE_EDITS = 64;
const MAX_FILES = 8;

/** Ops has no separate approval step; this shape stays for result and journal compatibility. */
export interface MutationApproval {
    readonly required: false;
    readonly requests: number;
    readonly approved: boolean;
}

const NO_APPROVAL: MutationApproval = { required: false, requests: 0, approved: false };

export interface MutationFileResult {
    readonly path: string;
    readonly status: "not_written" | "written" | "restored" | "rollback_failed";
    readonly error?: { readonly code: string; readonly message: string };
}

export interface MutationResult {
    readonly ok: boolean;
    readonly phase: "validation" | "approval" | "write" | "rollback" | "done";
    readonly approval: MutationApproval;
    readonly rolledBack: boolean;
    readonly partial: boolean;
    readonly files: readonly MutationFileResult[];
    readonly error?: { readonly code: string; readonly message: string };
}

export type MutationJournalFileStatus =
    "not_written" | "started" | "written" | "restored" | "rollback_failed" | "uncertain";

export type MutationJournalBatchStatus =
    "pending" | "writing" | "done" | "failed" | "cancelled" | "timeout" | "uncertain";

export type MutationJournalFile = {
    readonly path: string;
    readonly kind: "new" | "existing";
    readonly beforeHash: string | null;
    readonly finalHash: string;
    readonly status: MutationJournalFileStatus;
};

export type MutationJournalBatch = {
    readonly callId: string;
    readonly taskId: string;
    readonly actor: string;
    readonly conversationId: number;
    readonly scopeHash: string;
    readonly configHash: string;
    readonly tool: MutationTool;
    readonly status: MutationJournalBatchStatus;
    readonly phase: MutationResult["phase"];
    files: MutationJournalFile[];
    readonly createdAt: number;
    readonly updatedAt: number;
};

export type MutationJournal = {
    readonly version: 1;
    batches: MutationJournalBatch[];
};

/** Durable per-file status for explicit mutations; it stores hashes and statuses, never content. */
export const OpsMutationsDoc = defineDoc<MutationJournal>({
    kind: "x.pi-pocket-ops.mutations",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ version: 1, batches: [] }),
});

export interface MutationJournalTx {
    doc<T>(token: unknown, conversationId: number): Promise<T>;
}

/** The small part of the durable tool API this module binds to. */
export interface MutationApi {
    readonly taskId: number | string;
    readonly callId: string;
    readonly conversationId: number;
    snapshot?<T>(doc: unknown, context: unknown): Promise<T | undefined>;
    commit?<T>(change: (tx: MutationJournalTx) => T | Promise<T>, context: unknown): Promise<T>;
}

export interface MutationJournalHandle {
    plan(plan: MutationPlan): Promise<void>;
    writing(): Promise<void>;
    start(index: number): Promise<void>;
    written(index: number): Promise<void>;
    settle(
        status: "failed" | "cancelled" | "timeout" | "uncertain",
        phase: MutationResult["phase"],
        files: readonly MutationFileResult[],
    ): Promise<void>;
    done(files: readonly MutationFileResult[]): Promise<void>;
}

function cloneJournalBatch(batch: MutationJournalBatch): MutationJournalBatch {
    return { ...batch, files: batch.files.map((file) => ({ ...file })) };
}

function journalRefusal(): OpsError {
    return new OpsError(
        "journal",
        "ops: the durable mutation journal could not be written; no further file change is allowed",
    );
}

/** Build the durable journal for one tool call, or undefined on the controlled unit path without commit. */
export function createMutationJournal(
    api: MutationApi,
    context: unknown,
    meta: {
        readonly callId: string;
        readonly taskId: string;
        readonly actor: string;
        readonly conversationId: number;
        readonly scopeHash: string;
        readonly configHash: string;
        readonly tool: MutationTool;
    },
): MutationJournalHandle | undefined {
    if (typeof api.commit !== "function") {
        return undefined;
    }

    const commit = api.commit.bind(api);
    let batch: MutationJournalBatch | undefined;

    const write = async (): Promise<void> => {
        if (batch === undefined) {
            throw journalRefusal();
        }

        batch = { ...batch, updatedAt: Date.now() };
        const snapshot = cloneJournalBatch(batch);

        try {
            await commit(async (tx) => {
                const doc = await tx.doc<{
                    version: 1;
                    batches: MutationJournalBatch[];
                }>(OpsMutationsDoc, meta.conversationId);
                const batches = Array.isArray(doc.batches) ? [...doc.batches] : [];
                const existing = batches.findIndex(
                    (entry) => entry.callId === snapshot.callId && entry.taskId === snapshot.taskId,
                );

                if (existing >= 0) {
                    batches[existing] = snapshot;
                } else {
                    batches.push(snapshot);
                }

                doc.version = 1;
                doc.batches = batches.slice(-16);

                return undefined;
            }, context);
        } catch {
            throw journalRefusal();
        }
    };

    const setFile = (index: number, status: MutationJournalFileStatus): void => {
        if (batch === undefined || batch.files[index] === undefined) {
            throw journalRefusal();
        }

        batch = {
            ...batch,
            status: "writing",
            phase: "write",
            files: batch.files.map((file, at) => (at === index ? { ...file, status } : file)),
        };
    };

    const setFiles = (
        status: "failed" | "cancelled" | "timeout" | "uncertain" | "done",
        phase: MutationResult["phase"],
        files: readonly MutationFileResult[],
    ): void => {
        if (batch === undefined) {
            return;
        }

        batch = {
            ...batch,
            status,
            phase,
            files: batch.files.map((file, index) => {
                const result = files.find((entry) => entry.path === file.path) ?? files[index];

                return result === undefined
                    ? { ...file, status: "uncertain" }
                    : { ...file, status: result.status };
            }),
        };
    };

    return {
        async plan(plan) {
            const now = Date.now();

            batch = {
                ...meta,
                status: "pending",
                phase: "validation",
                files: plan.entries.map((entry) => ({
                    path: entry.path,
                    kind: entry.target.kind,
                    beforeHash: entry.target.kind === "existing" ? entry.target.originalHash : null,
                    finalHash: entry.finalHash,
                    status: "not_written",
                })),
                createdAt: now,
                updatedAt: now,
            };
            await write();
        },
        async writing() {
            if (batch === undefined) {
                throw journalRefusal();
            }

            batch = { ...batch, status: "writing", phase: "write" };
            await write();
        },
        async start(index) {
            setFile(index, "started");
            await write();
        },
        async written(index) {
            setFile(index, "written");
            await write();
        },
        async settle(status, phase, files) {
            setFiles(status, phase, files);
            await write();
        },
        async done(files) {
            setFiles("done", "done", files);
            await write();
        },
    };
}

export interface MutationJournalReader {
    snapshot(doc: unknown, conversationId: number, context: unknown): Promise<unknown>;
}

/** Read the journal defensively; an unknown shape is reported as unavailable, never as complete. */
export async function readMutationJournal(
    reader: MutationJournalReader,
    conversationId: number,
    context: unknown,
): Promise<MutationJournal | undefined> {
    let value: unknown;

    try {
        value = await reader.snapshot(OpsMutationsDoc, conversationId, context);
    } catch {
        return undefined;
    }

    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.batches)) {
        return undefined;
    }

    return value as MutationJournal;
}

function shortHash(hash: string): string {
    return hash.slice(0, 12);
}

function journalNote(batch: MutationJournalBatch): string {
    const started = batch.files.some(
        (file) => file.status === "started" || file.status === "uncertain",
    );
    const failed = batch.files.some((file) => file.status === "rollback_failed");

    if (batch.status === "done") {
        return "Recorded complete for this batch.";
    }

    if (batch.status === "pending") {
        return "Pending; no file write is recorded as started. Do not assume complete.";
    }

    if (batch.status === "writing") {
        return batch.files.every((file) => file.status === "written")
            ? "All listed files are recorded written, but the final receipt is not committed; do not assume the batch is complete."
            : "In progress or interrupted; a started file may be written. Do not assume complete.";
    }

    if (batch.status === "cancelled" || batch.status === "timeout") {
        return started
            ? "Cancelled or timed out with a started/uncertain file. Verify every listed path."
            : "Cancelled or timed out before a file write was recorded; do not assume complete.";
    }

    if (batch.status === "uncertain" || failed || started) {
        return "Failed or uncertain; some files may remain changed. Verify every listed path.";
    }

    return "Failed; no listed file is recorded as written.";
}

/** Render one batch as plain text; it never includes file content. */
export function formatMutationJournal(doc: MutationJournal | undefined, callId?: string): string {
    if (doc === undefined) {
        return "Ops mutation journal: not recorded or unavailable. Unknown, not complete.";
    }

    const batches = Array.isArray(doc.batches) ? doc.batches : [];

    if (batches.length === 0) {
        return "Ops mutation journal: no batches recorded in this conversation. Unknown, not complete.";
    }

    const batch =
        callId === undefined ? batches.at(-1) : batches.find((entry) => entry.callId === callId);

    if (batch === undefined) {
        const known = batches
            .slice(-8)
            .map((entry) => entry.callId)
            .join(", ");

        return `Ops mutation journal: no recorded batch for ${callId ?? "the requested call"}. Known calls: ${known}. Unknown, not complete.`;
    }

    const files = batch.files
        .map((file) => {
            const status =
                file.status === "started"
                    ? "started (possibly written; not verified)"
                    : file.status;
            const before = file.beforeHash === null ? "none" : shortHash(file.beforeHash);

            return `- [${status}] ${file.path} (${file.kind}; before ${before} -> final ${shortHash(file.finalHash)})`;
        })
        .join("\n");

    return [
        "Ops mutation journal (durable, last 16; hashes only, no content)",
        `call ${batch.callId} · task ${batch.taskId} · actor ${batch.actor}`,
        `tool ${batch.tool} · phase ${batch.phase} · status ${batch.status} · scope ${shortHash(batch.scopeHash)} · config ${shortHash(batch.configHash)}`,
        `updated ${new Date(batch.updatedAt).toISOString()}`,
        `files (${batch.files.length}):`,
        files === "" ? "- (none)" : files,
        journalNote(batch),
    ].join("\n");
}

export interface MutationLock {
    run<T>(work: () => Promise<T>): Promise<T>;
}

export interface MutationOptions {
    readonly tool: MutationTool;
    readonly rawArgs: unknown;
    readonly config: Config;
    readonly scope: Scope;
    readonly runtimeKey: string;
    readonly api: MutationApi;
    readonly context: unknown;
    readonly signal: AbortSignal;
    readonly epoch: () => void;
    readonly lock: MutationLock;
    readonly executionTimeoutMs: number;
}

interface ParsedEdit {
    readonly oldText: string;
    readonly newText: string;
}

interface ParsedFile {
    readonly path: string;
    readonly content?: string;
    readonly edits?: readonly ParsedEdit[];
}

interface ParsedInput {
    readonly files: readonly ParsedFile[];
    readonly inputBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function errorOf(error: unknown): { readonly code: string; readonly message: string } {
    if (error instanceof OpsError) {
        return { code: error.code, message: error.message };
    }

    return { code: "io", message: safeErrorMessage(error) };
}

function labelOf(file: unknown, index: number): string {
    if (isRecord(file) && typeof file.path === "string") {
        const clean = file.path
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/gu, "")
            .slice(0, 200);

        return clean === "" ? `#${index + 1}` : clean;
    }

    return `#${index + 1}`;
}

function labelsFor(rawArgs: unknown): string[] {
    if (!isRecord(rawArgs) || !Array.isArray(rawArgs.files)) {
        return [];
    }

    return rawArgs.files.map(labelOf);
}

function notWritten(paths: readonly string[]): MutationFileResult[] {
    return paths.map((path) => ({ path, status: "not_written" as const }));
}

function resultFor(
    phase: MutationResult["phase"],
    rolledBack: boolean,
    partial: boolean,
    files: readonly MutationFileResult[],
    error?: { readonly code: string; readonly message: string },
): MutationResult {
    return {
        ok: false,
        phase,
        approval: NO_APPROVAL,
        rolledBack,
        partial,
        files,
        ...(error === undefined ? {} : { error }),
    };
}

function parseMutationInput(tool: MutationTool, raw: unknown): ParsedInput {
    if (!isRecord(raw)) {
        fail("shape", "ops: arguments must be an object; no file was written");
    }

    for (const key of Object.keys(raw)) {
        if (key !== "files") {
            fail("shape", "ops: arguments contain an unknown field; no file was written");
        }
    }

    if (!Array.isArray(raw.files)) {
        fail("shape", "ops: files must be an array; no file was written");
    }

    if (raw.files.length < 1 || raw.files.length > MAX_FILES) {
        fail("too-many", `ops: this call allows 1 to ${MAX_FILES} files; no file was written`);
    }

    const files: ParsedFile[] = [];

    for (const value of raw.files) {
        if (!isRecord(value)) {
            fail("shape", "ops: every file must be an object; no file was written");
        }

        const allowed = tool === "ops_write" ? ["path", "content"] : ["path", "edits"];

        for (const key of Object.keys(value)) {
            if (!allowed.includes(key)) {
                fail("shape", "ops: a file has an unknown field; no file was written");
            }
        }

        if (typeof value.path !== "string" || value.path.length === 0) {
            fail("path", "ops: every file needs a non-empty relative path; no file was written");
        }

        if (value.path.length > MAX_PATH_CHARS) {
            fail("path", "ops: a path is too long; no file was written");
        }

        if (tool === "ops_write") {
            if (typeof value.content !== "string") {
                fail("shape", "ops: ops_write needs content; no file was written");
            }

            checkMutationText(value.content, "file content");
            files.push({ path: value.path, content: value.content });
            continue;
        }

        if (!Array.isArray(value.edits)) {
            fail("shape", "ops: ops_edit needs edits; no file was written");
        }

        if (value.edits.length < 1 || value.edits.length > MAX_FILE_EDITS) {
            fail("edit", `ops: every file needs 1 to ${MAX_FILE_EDITS} edits; no file was written`);
        }

        const edits: ParsedEdit[] = [];

        for (const edit of value.edits) {
            if (!isRecord(edit)) {
                fail("shape", "ops: every edit must be an object; no file was written");
            }

            for (const key of Object.keys(edit)) {
                if (key !== "oldText" && key !== "newText") {
                    fail("shape", "ops: an edit has an unknown field; no file was written");
                }
            }

            if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
                fail("edit", "ops: every oldText must be a non-empty string; no file was written");
            }

            if (typeof edit.newText !== "string") {
                fail("edit", "ops: every newText must be a string; no file was written");
            }

            checkMutationText(edit.oldText, "oldText");
            checkMutationText(edit.newText, "newText");
            edits.push({ oldText: edit.oldText, newText: edit.newText });
        }

        files.push({ path: value.path, edits });
    }

    const canonical = canonicalInput(tool, files);

    return {
        files,
        inputBytes: Buffer.byteLength(JSON.stringify(canonical), "utf8"),
    };
}

function canonicalInput(tool: MutationTool, files: readonly ParsedFile[]): unknown {
    return {
        tool,
        files: files.map((file) =>
            tool === "ops_write"
                ? { path: file.path, content: file.content }
                : {
                      path: file.path,
                      edits: (file.edits ?? []).map((edit) => ({
                          oldText: edit.oldText,
                          newText: edit.newText,
                      })),
                  },
        ),
    };
}

function hashScope(scope: Scope, runtimeKey: string): string {
    return sha256(
        JSON.stringify({
            conversationId: scope.conversationId,
            requester: scope.requester,
            cwd: scope.cwd,
            cwdDev: scope.cwdStat.dev,
            cwdIno: scope.cwdStat.ino,
            root: scope.root,
            runtimeKey,
        }),
    );
}

function planInput(tool: MutationTool, parsed: ParsedFile): MutationFileInput {
    return tool === "ops_write"
        ? { path: parsed.path, content: parsed.content }
        : { path: parsed.path, edits: parsed.edits };
}

async function executeAndRollback(
    plan: MutationPlan,
    signal: AbortSignal,
    journal: MutationJournalHandle | undefined,
): Promise<MutationResult> {
    let execution;

    try {
        execution = await executeMutationPlan(plan, signal, journal);
    } catch {
        const files: MutationFileResult[] = plan.entries.map((entry) => ({
            path: entry.path,
            status: "rollback_failed" as const,
            error: {
                code: "internal",
                message: "ops: the write phase failed unexpectedly; verify the listed files",
            },
        }));

        if (journal !== undefined) {
            try {
                await journal.settle("uncertain", "rollback", files);
            } catch {
                // The last committed journal state remains the durable record.
            }
        }

        return resultFor("rollback", false, true, files, {
            code: "internal",
            message: "ops: the write phase failed unexpectedly; verify the listed files",
        });
    }

    if (execution.failures.size === 0) {
        const files: MutationFileResult[] = plan.entries.map((entry) => ({
            path: entry.path,
            status: "written" as const,
        }));

        if (journal !== undefined) {
            try {
                await journal.done(files);
            } catch (error) {
                return {
                    ok: false,
                    phase: "write",
                    approval: NO_APPROVAL,
                    rolledBack: false,
                    partial: true,
                    files,
                    error: errorOf(error),
                };
            }
        }

        return {
            ok: true,
            phase: "done",
            approval: NO_APPROVAL,
            rolledBack: false,
            partial: false,
            files,
        };
    }

    const rollback = await rollbackMutationPlan(plan, execution.touched);
    const files: MutationFileResult[] = plan.entries.map((entry, index) => {
        const outcome = rollback.get(index);

        if (outcome !== undefined) {
            return {
                path: entry.path,
                status: outcome.status,
                ...(outcome.error === undefined ? {} : { error: outcome.error }),
            };
        }

        const failure = execution.failures.get(index);

        return {
            path: entry.path,
            status: "not_written" as const,
            ...(failure === undefined ? {} : { error: errorOf(failure) }),
        };
    });
    const unsafe = [...execution.touched].filter((index) => rollback.get(index)?.safe !== true);
    const partial =
        unsafe.length > 0 ||
        files.some((file) => file.status === "rollback_failed" || file.status === "written");
    const rolledBack = execution.touched.size > 0 && unsafe.length === 0;
    const rollbackError = [...rollback.values()].find(
        (outcome) => outcome.status === "rollback_failed",
    )?.error;
    const firstFailure = [...execution.failures.values()][0];
    const failure =
        rollbackError ??
        (firstFailure === undefined
            ? { code: "write", message: "ops: the batch failed; no file was written" }
            : errorOf(firstFailure));
    const phase = execution.touched.size > 0 ? "rollback" : "write";

    let result = resultFor(
        phase,
        rolledBack,
        partial,
        files,
        partial
            ? {
                  code: "rollback_failed",
                  message:
                      "ops: the batch failed and rollback could not restore every file; verify the listed files",
              }
            : failure,
    );

    if (journal !== undefined) {
        try {
            await journal.settle("failed", phase, files);
        } catch {
            result = {
                ...result,
                partial: true,
                error: {
                    code: "journal",
                    message:
                        "ops: the batch failed and the durable journal could not record the final state; run /ops-mutations [call-id] before assuming any path is unchanged",
                },
            };
        }
    }

    return result;
}

/** Run one explicit mutation. Any failure returns a complete per-file result and never a silent partial write. */
export async function runMutation(options: MutationOptions): Promise<MutationResult> {
    const labels = labelsFor(options.rawArgs);

    const taskId = options.api.taskId;
    const validTaskId =
        (typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0) ||
        (typeof taskId === "string" && taskId.length > 0);

    if (!validTaskId || typeof options.api.callId !== "string" || options.api.callId === "") {
        return resultFor("validation", false, false, notWritten(labels), {
            code: "identity",
            message: "ops: the call identity is unavailable; no file was written",
        });
    }

    let input: ParsedInput;

    try {
        input = parseMutationInput(options.tool, options.rawArgs);
    } catch (error) {
        return failedMutation(options.tool, options.rawArgs, error);
    }

    const paths = input.files.map((file) => file.path);
    const scopeKey = hashScope(options.scope, options.runtimeKey);
    const journal = createMutationJournal(options.api, options.context, {
        callId: options.api.callId,
        taskId: String(options.api.taskId),
        actor: options.scope.requester,
        conversationId: options.scope.conversationId,
        scopeHash: scopeKey,
        configHash: sha256(options.runtimeKey),
        tool: options.tool,
    });

    if (journal === undefined) {
        const durableApi =
            typeof options.api.snapshot === "function" ||
            typeof (options.api as { readonly diagnostic?: unknown }).diagnostic === "function" ||
            typeof (options.api as { readonly signal?: { readonly aborted?: unknown } }).signal
                ?.aborted === "boolean";

        if (durableApi) {
            return resultFor("validation", false, false, notWritten(paths), {
                code: "journal",
                message:
                    "ops: the durable mutation journal API is unavailable; no file was written",
            });
        }
    }

    let plan: MutationPlan | undefined;

    try {
        options.epoch();
        plan = await buildMutationPlan({
            scope: options.scope,
            config: options.config,
            tool: options.tool,
            files: input.files.map((file) => planInput(options.tool, file)),
            inputBytes: input.inputBytes,
            signal: options.signal,
        });

        try {
            await revalidateMutationPlan(plan, options.signal);
        } catch (error) {
            return resultFor(
                "validation",
                false,
                false,
                notWritten(plan.entries.map((entry) => entry.path)),
                errorOf(error),
            );
        }

        options.epoch();

        if (journal !== undefined) {
            try {
                await journal.plan(plan);
            } catch (error) {
                return resultFor(
                    "validation",
                    false,
                    false,
                    notWritten(plan.entries.map((entry) => entry.path)),
                    errorOf(error),
                );
            }
        }

        let execution: MutationResult;

        try {
            execution = await options.lock.run(async () => {
                options.epoch();
                await revalidateMutationPlan(plan!, options.signal);
                options.epoch();

                if (journal !== undefined) {
                    await journal.writing();
                }

                const gate = new AbortController();
                const timer = setTimeout(
                    () =>
                        gate.abort(
                            new OpsError(
                                "timeout",
                                "ops: the write phase timed out; rollback was attempted",
                            ),
                        ),
                    options.executionTimeoutMs,
                );

                timer.unref?.();

                const combined = combineSignals([options.signal, gate.signal]);

                try {
                    return await executeAndRollback(plan!, combined.signal, journal);
                } finally {
                    clearTimeout(timer);
                    combined.cleanup();
                }
            });
        } catch (error) {
            return resultFor(
                "validation",
                false,
                false,
                notWritten(plan.entries.map((entry) => entry.path)),
                errorOf(error),
            );
        }

        return execution;
    } catch (error) {
        return resultFor(
            "validation",
            false,
            false,
            notWritten(plan?.entries.map((entry) => entry.path) ?? paths),
            errorOf(error),
        );
    } finally {
        if (plan !== undefined) {
            await closeMutationPlan(plan);
        }
    }
}

/** A safe failure before a plan exists. */
export function failedMutation(
    tool: MutationTool,
    rawArgs: unknown,
    error: unknown,
): MutationResult {
    void tool;

    return resultFor("validation", false, false, notWritten(labelsFor(rawArgs)), errorOf(error));
}

/** A conservative result when an unexpected error escapes after the mutation started. */
export function unexpectedMutationFailure(rawArgs: unknown, error: unknown): MutationResult {
    const message = "ops: the mutation failed unexpectedly; verify the listed files";
    const labels = labelsFor(rawArgs);

    void error;

    return {
        ok: false,
        phase: "rollback",
        approval: NO_APPROVAL,
        rolledBack: false,
        partial: true,
        files:
            labels.length === 0
                ? []
                : labels.map((path) => ({
                      path,
                      status: "rollback_failed" as const,
                      error: { code: "internal", message },
                  })),
        error: { code: "internal", message },
    };
}
