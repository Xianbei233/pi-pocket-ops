/**
 * Race-resistant, root-bound file mutation primitives for the explicit ops_write/ops_edit tools.
 *
 * Linux only. Every parent is opened with O_NOFOLLOW from the trusted cwd and kept open. An existing target is opened
 * O_RDWR without truncating it and read through the same descriptor; a new target is created O_CREAT|O_EXCL only after the
 * host approval. The plan is revalidated before writing, and rollback only touches the inode bound by this call.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { canonicalCwd, directoryIdentity } from "./fs-safe.ts";
import { fail, OpsError } from "./errors.ts";
import { isInside, relativeSegments, sameStat, statKey } from "./paths.ts";
import type { Config, Scope, StatKey } from "./types.ts";

const FD_ROOT = "/proc/self/fd";
const CHUNK = 64 * 1024;

/** Hard caps; the owner's existing limits can only narrow them. */
export const MUTATION_MAX_FILES = 8;
export const MUTATION_MAX_EDITS = 64;
export const MUTATION_MAX_BYTES = 1_048_576;

export interface MutationEdit {
    readonly oldText: string;
    readonly newText: string;
}

export interface MutationFileInput {
    readonly path: string;
    readonly content?: string;
    readonly edits?: readonly MutationEdit[];
}

export interface ExistingTarget {
    readonly kind: "existing";
    readonly parent: FileHandle;
    readonly parentPath: string;
    readonly name: string;
    readonly targetPath: string;
    readonly handle: FileHandle;
    readonly original: Buffer;
    readonly originalHash: string;
    readonly stat: StatKey;
}

export interface NewTarget {
    readonly kind: "new";
    readonly parent: FileHandle;
    readonly parentPath: string;
    readonly name: string;
    readonly targetPath: string;
    created?: FileHandle;
    createdStat?: StatKey;
}

export interface MutationPlanEntry {
    readonly path: string;
    readonly segments: readonly string[];
    readonly tool: "ops_write" | "ops_edit";
    readonly final: Buffer;
    readonly finalHash: string;
    readonly parentStat: StatKey;
    readonly target: ExistingTarget | NewTarget;
    afterWrite?: { readonly hash: string; readonly size: number };
}

export interface MutationPlan {
    readonly entries: readonly MutationPlanEntry[];
    readonly scope: Scope;
    readonly limit: number;
}

export interface ExecutionResult {
    readonly failures: ReadonlyMap<number, OpsError>;
    readonly touched: ReadonlySet<number>;
}

export interface MutationExecutionObserver {
    start(index: number): Promise<void>;
    written(index: number): Promise<void>;
}

export interface RollbackOutcome {
    readonly status: "restored" | "rollback_failed" | "not_written";
    readonly safe: boolean;
    readonly error?: { readonly code: string; readonly message: string };
}

export function assertMutationPlatform(): void {
    if (process.platform !== "linux") {
        fail(
            "platform",
            "ops: explicit writes need Linux /proc/self/fd verification; writes are disabled here",
        );
    }

    if (
        constants.O_NOFOLLOW === undefined ||
        constants.O_DIRECTORY === undefined ||
        constants.O_CREAT === undefined ||
        constants.O_EXCL === undefined
    ) {
        fail(
            "platform",
            "ops: this platform lacks the no-follow open flags; writes are disabled here",
        );
    }
}

function fdPath(fd: number): string {
    return `${FD_ROOT}/${fd}`;
}

function sha256(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

function mapFsError(error: unknown): never {
    if (error instanceof OpsError) {
        throw error;
    }

    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    if (
        code === "ENOENT" ||
        code === "EACCES" ||
        code === "ELOOP" ||
        code === "ENOTDIR" ||
        code === "EISDIR"
    ) {
        fail("unavailable", "ops: path is unavailable");
    }

    if (code === "EEXIST") {
        fail("changed", "ops: the target appeared after approval; no file was written");
    }

    if (code === "EMFILE" || code === "ENFILE") {
        fail("busy", "ops: too many open files; retry later");
    }

    fail("io", "ops: file operation failed safely");
}

function asOpsError(error: unknown): OpsError {
    if (error instanceof OpsError) {
        return error;
    }

    return new OpsError("io", "ops: file operation failed safely");
}

function abortError(signal: AbortSignal): OpsError {
    const reason = signal.reason;

    return reason instanceof OpsError
        ? reason
        : new OpsError("cancelled", "ops: request was cancelled");
}

function checkAbort(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw abortError(signal);
    }
}

/** Reject malformed Unicode, NUL, and binary control bytes in text that will be written. */
export function checkMutationText(value: string, what: string): void {
    if (typeof value !== "string" || value.isWellFormed() !== true) {
        fail("text", `ops: ${what} is not well-formed Unicode; no file was written`);
    }

    if (value.includes("\u0000")) {
        fail("text", `ops: ${what} contains NUL; no file was written`);
    }

    if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
        fail("text", `ops: ${what} contains binary control characters; no file was written`);
    }
}

/** Decode strict UTF-8; a BOM is kept so an edit does not silently remove it. */
export function decodeMutationText(buffer: Buffer, what: string): string {
    let text;

    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
        fail("text", `ops: ${what} is not strict UTF-8; no file was written`);
    }

    checkMutationText(text, what);

    return text;
}

/** Apply every replacement against the original text; each oldText must match once and ranges must not overlap. */
export function applyMutationEdits(
    original: string,
    edits: readonly MutationEdit[],
    path: string,
): string {
    if (edits.length < 1 || edits.length > MUTATION_MAX_EDITS) {
        fail("edit", "ops: every file needs 1 to 64 edits; no file was written");
    }

    const ranges = edits.map((edit) => {
        checkMutationText(edit.oldText, "oldText");

        checkMutationText(edit.newText, "newText");

        if (edit.oldText.length === 0) {
            fail("edit", `ops: ${path} has an empty oldText; no file was written`);
        }

        const first = original.indexOf(edit.oldText);

        if (first < 0) {
            fail("edit", `ops: ${path} has an oldText that was not found; no file was written`);
        }

        if (original.indexOf(edit.oldText, first + 1) !== -1) {
            fail(
                "edit",
                `ops: ${path} has an oldText that matches more than once; no file was written`,
            );
        }

        return { start: first, end: first + edit.oldText.length, text: edit.newText };
    });

    ranges.sort((left, right) => left.start - right.start);

    for (let index = 1; index < ranges.length; index++) {
        if (ranges[index]!.start < ranges[index - 1]!.end) {
            fail("edit", `ops: ${path} has overlapping edits; no file was written`);
        }
    }

    let output = "";
    let position = 0;

    for (const range of ranges) {
        output += original.slice(position, range.start) + range.text;
        position = range.end;
    }

    return output + original.slice(position);
}

async function verifyFd(handle: FileHandle, expected: string, root: string): Promise<void> {
    let actual;

    try {
        actual = await realpath(fdPath(handle.fd));
    } catch {
        fail("changed", "ops: cannot verify the open object; no file was written");
    }

    if (actual !== expected || !isInside(actual, root)) {
        fail("changed", "ops: the open object is not the approved path; no file was written");
    }
}

async function verifyParent(
    parent: FileHandle,
    expectedPath: string,
    root: string,
): Promise<StatKey> {
    let actual;

    try {
        actual = await realpath(fdPath(parent.fd));
    } catch {
        fail("changed", "ops: the approved parent folder is gone; no file was written");
    }

    if (actual !== expectedPath || !isInside(actual, root)) {
        fail("changed", "ops: the approved parent folder changed; no file was written");
    }

    const info = await parent.stat({ bigint: true });

    if (!info.isDirectory()) {
        fail("changed", "ops: the approved parent is not a directory; no file was written");
    }

    return statKey(info);
}

async function openParentChain(
    scope: Scope,
    segments: readonly string[],
): Promise<{ readonly handle: FileHandle; readonly path: string; readonly stat: StatKey }> {
    assertMutationPlatform();

    const parentSegments = segments.slice(0, -1);
    let current: FileHandle | undefined;

    try {
        current = await open(
            scope.cwd,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
        );

        await verifyFd(current, scope.cwd, scope.root);
    } catch (error) {
        await current?.close().catch(() => {});

        mapFsError(error);
    }

    current = current!;

    try {
        for (let index = 0; index < parentSegments.length; index++) {
            const segment = parentSegments[index]!;
            const expected = join(scope.cwd, ...parentSegments.slice(0, index + 1));
            const next = await open(
                `${fdPath(current.fd)}/${segment}`,
                constants.O_RDONLY |
                    constants.O_DIRECTORY |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK,
            );

            try {
                await verifyFd(next, expected, scope.root);
            } catch (error) {
                await next.close().catch(() => {});

                throw error;
            }

            await current.close().catch(() => {});
            current = next;
        }

        const stat = await verifyParent(current, join(scope.cwd, ...parentSegments), scope.root);

        return { handle: current, path: join(scope.cwd, ...parentSegments), stat };
    } catch (error) {
        await current.close().catch(() => {});

        mapFsError(error);
    }
}

async function lstatMaybe(path: string): Promise<BigIntStats | undefined> {
    try {
        return await lstat(path, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        mapFsError(error);
    }
}

async function assertMissing(parent: FileHandle, name: string): Promise<void> {
    const found = await lstatMaybe(`${fdPath(parent.fd)}/${name}`);

    if (found !== undefined) {
        fail("changed", "ops: a new target appeared after approval; no file was written");
    }
}

async function verifyEntry(parent: FileHandle, name: string, expected: StatKey): Promise<void> {
    const found = await lstatMaybe(`${fdPath(parent.fd)}/${name}`);

    if (found === undefined || !found.isFile()) {
        fail("changed", "ops: the approved target changed; no file was written");
    }

    const key = statKey(found);

    if (key.dev !== expected.dev || key.ino !== expected.ino || key.nlink !== 1) {
        fail("changed", "ops: the approved target changed; no file was written");
    }
}

async function readAll(
    handle: FileHandle,
    size: number,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    while (total < size) {
        checkAbort(signal);

        const wanted = Math.min(CHUNK, size - total);
        const buffer = Buffer.allocUnsafe(wanted);
        const { bytesRead } = await handle.read(buffer, 0, wanted, total);

        if (bytesRead === 0) {
            break;
        }

        total += bytesRead;

        if (total > limit) {
            fail("too-large", "ops: file is larger than the configured limit; no file was written");
        }

        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, total);
}

async function readSnapshot(
    handle: FileHandle,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<{ readonly buffer: Buffer; readonly hash: string; readonly stat: StatKey }> {
    const before = statKey(await handle.stat({ bigint: true }));

    if (before.size > limit) {
        fail("too-large", "ops: file is larger than the configured limit; no file was written");
    }

    const buffer = await readAll(handle, before.size, limit, signal);
    const after = statKey(await handle.stat({ bigint: true }));

    if (!sameStat(before, after) || buffer.length !== after.size) {
        fail("changed", "ops: file changed while it was read; no file was written");
    }

    return { buffer, hash: sha256(buffer), stat: after };
}

async function openExisting(
    scope: Scope,
    parent: FileHandle,
    name: string,
    targetPath: string,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<{
    readonly handle: FileHandle;
    readonly original: Buffer;
    readonly originalHash: string;
    readonly stat: StatKey;
}> {
    let handle: FileHandle | undefined;

    try {
        handle = await open(
            `${fdPath(parent.fd)}/${name}`,
            constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );

        const info = await handle.stat({ bigint: true });

        if (!info.isFile()) {
            fail("path", "ops: the target is not a regular file; no file was written");
        }

        if (info.nlink !== 1n) {
            fail("path", "ops: hard-linked files are not written; no file was written");
        }

        if (info.size > BigInt(limit)) {
            fail("too-large", "ops: file is larger than the configured limit; no file was written");
        }

        await verifyFd(handle, targetPath, scope.root);

        const opened = statKey(info);
        const snapshot = await readSnapshot(handle, limit, signal);

        if (!sameStat(opened, snapshot.stat)) {
            fail("changed", "ops: file changed while it was read; no file was written");
        }

        await verifyEntry(parent, name, snapshot.stat);

        return {
            handle,
            original: snapshot.buffer,
            originalHash: snapshot.hash,
            stat: snapshot.stat,
        };
    } catch (error) {
        await handle?.close().catch(() => {});

        mapFsError(error);
    }
}

async function writeAll(handle: FileHandle, buffer: Buffer, signal?: AbortSignal): Promise<void> {
    let offset = 0;

    while (offset < buffer.length) {
        checkAbort(signal);

        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);

        if (bytesWritten <= 0) {
            fail("io", "ops: file write made no progress");
        }

        offset += bytesWritten;
    }
}

async function snapshotAfterWrite(
    handle: FileHandle,
    limit: number,
): Promise<{ readonly hash: string; readonly size: number } | undefined> {
    try {
        const snapshot = await readSnapshot(handle, limit, undefined);

        return { hash: snapshot.hash, size: snapshot.buffer.length };
    } catch {
        return undefined;
    }
}

async function writeExisting(
    entry: MutationPlanEntry,
    limit: number,
    signal: AbortSignal,
): Promise<void> {
    const target = entry.target;

    if (target.kind !== "existing") {
        fail("io", "ops: internal mutation state is invalid");
    }

    checkAbort(signal);

    try {
        await writeAll(target.handle, entry.final, signal);
        await target.handle.truncate(entry.final.length);
        await target.handle.sync();

        const after = await snapshotAfterWrite(target.handle, limit);

        if (
            after === undefined ||
            after.hash !== entry.finalHash ||
            after.size !== entry.final.length
        ) {
            fail("io", "ops: cannot verify the written file");
        }

        entry.afterWrite = after;
        await verifyEntry(target.parent, target.name, target.stat);
    } catch (error) {
        entry.afterWrite = await snapshotAfterWrite(target.handle, limit);

        throw error;
    }
}

async function writeNew(
    entry: MutationPlanEntry,
    scope: Scope,
    limit: number,
    signal: AbortSignal,
): Promise<void> {
    const target = entry.target;

    if (target.kind !== "new") {
        fail("io", "ops: internal mutation state is invalid");
    }

    checkAbort(signal);

    let handle: FileHandle;

    try {
        handle = await open(
            `${fdPath(target.parent.fd)}/${target.name}`,
            constants.O_RDWR |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
            0o666,
        );
    } catch (error) {
        mapFsError(error);
    }

    target.created = handle;

    try {
        const info = await handle.stat({ bigint: true });

        if (!info.isFile() || info.nlink !== 1n) {
            fail("changed", "ops: the new file was replaced; no rollback is safe");
        }

        target.createdStat = statKey(info);
        await verifyFd(handle, target.targetPath, scope.root);
        await writeAll(handle, entry.final, signal);
        await handle.sync();

        const after = await snapshotAfterWrite(handle, limit);

        if (
            after === undefined ||
            after.hash !== entry.finalHash ||
            after.size !== entry.final.length
        ) {
            fail("io", "ops: cannot verify the new file");
        }

        entry.afterWrite = after;
        await verifyEntry(target.parent, target.name, target.createdStat);
    } catch (error) {
        entry.afterWrite = await snapshotAfterWrite(handle, limit);

        throw error;
    }
}

async function revalidateEntry(
    entry: MutationPlanEntry,
    plan: MutationPlan,
    signal: AbortSignal | undefined,
): Promise<void> {
    checkAbort(signal);

    const parentStat = await verifyParent(
        entry.target.parent,
        entry.target.parentPath,
        plan.scope.root,
    );

    if (parentStat.dev !== entry.parentStat.dev || parentStat.ino !== entry.parentStat.ino) {
        fail("changed", "ops: the approved parent folder changed; no file was written");
    }

    if (entry.target.kind === "existing") {
        const current = statKey(await entry.target.handle.stat({ bigint: true }));

        if (!sameStat(current, entry.target.stat)) {
            fail("changed", "ops: the approved file changed; no file was written");
        }

        const snapshot = await readSnapshot(entry.target.handle, plan.limit, signal);

        if (
            !sameStat(snapshot.stat, entry.target.stat) ||
            snapshot.hash !== entry.target.originalHash ||
            snapshot.buffer.length !== entry.target.original.length
        ) {
            fail("changed", "ops: the approved file content changed; no file was written");
        }

        await verifyEntry(entry.target.parent, entry.target.name, entry.target.stat);
    } else {
        await assertMissing(entry.target.parent, entry.target.name);
    }
}

/** Build a fully prechecked plan. No target or staging file is created or modified here. */
export async function buildMutationPlan(input: {
    readonly scope: Scope;
    readonly config: Config;
    readonly tool: "ops_write" | "ops_edit";
    readonly files: readonly MutationFileInput[];
    readonly inputBytes: number;
    readonly signal?: AbortSignal;
}): Promise<MutationPlan> {
    assertMutationPlatform();

    const limit = Math.min(MUTATION_MAX_BYTES, input.config.limits.maxFileBytes);
    const maxFiles = Math.min(MUTATION_MAX_FILES, input.config.limits.maxBatchOps);

    if (input.files.length < 1 || input.files.length > maxFiles) {
        fail("too-many", `ops: this call allows 1 to ${maxFiles} files; no file was written`);
    }

    if (input.inputBytes > limit) {
        fail(
            "too-large",
            "ops: the request is larger than the configured limit; no file was written",
        );
    }

    const seen = new Set<string>();
    const entries: MutationPlanEntry[] = [];
    let totalFinal = 0;
    let totalOriginal = 0;

    try {
        for (const file of input.files) {
            checkAbort(input.signal);

            const segments = relativeSegments(file.path, 4_096);
            const canonical = segments.join("/");

            if (seen.has(canonical)) {
                fail("duplicate", "ops: duplicate target path; no file was written");
            }

            seen.add(canonical);

            const parent = await openParentChain(input.scope, segments);
            let existingHandle: FileHandle | undefined;

            try {
                const name = segments.at(-1)!;
                const targetPath = join(parent.path, name);
                const found = await lstatMaybe(`${fdPath(parent.handle.fd)}/${name}`);
                let target: ExistingTarget | NewTarget;
                let originalLength = 0;
                let originalText: string | undefined;

                if (found !== undefined) {
                    if (found.isSymbolicLink() || !found.isFile()) {
                        fail("path", "ops: the target is not a regular file; no file was written");
                    }

                    const existing = await openExisting(
                        input.scope,
                        parent.handle,
                        name,
                        targetPath,
                        limit,
                        input.signal,
                    );

                    existingHandle = existing.handle;
                    target = {
                        kind: "existing",
                        parent: parent.handle,
                        parentPath: parent.path,
                        name,
                        targetPath,
                        handle: existing.handle,
                        original: existing.original,
                        originalHash: existing.originalHash,
                        stat: existing.stat,
                    };
                    originalLength = existing.original.length;
                    originalText = decodeMutationText(existing.original, "file content");
                } else {
                    if (input.tool === "ops_edit") {
                        fail(
                            "missing",
                            "ops: ops_edit target must already exist; no file was written",
                        );
                    }

                    target = {
                        kind: "new",
                        parent: parent.handle,
                        parentPath: parent.path,
                        name,
                        targetPath,
                    };
                }

                let finalText: string;

                if (input.tool === "ops_write") {
                    if (typeof file.content !== "string") {
                        fail("shape", "ops: ops_write needs content; no file was written");
                    }

                    checkMutationText(file.content, "file content");
                    finalText = file.content;
                } else {
                    if (originalText === undefined) {
                        fail(
                            "missing",
                            "ops: ops_edit target must already exist; no file was written",
                        );
                    }

                    if (!Array.isArray(file.edits)) {
                        fail("shape", "ops: ops_edit needs edits; no file was written");
                    }

                    finalText = applyMutationEdits(originalText, file.edits, canonical);
                }

                const final = Buffer.from(finalText, "utf8");

                if (final.length > limit) {
                    fail(
                        "too-large",
                        "ops: a file is larger than the configured limit; no file was written",
                    );
                }

                totalFinal += final.length;
                totalOriginal += originalLength;

                if (totalFinal > limit || totalOriginal > limit) {
                    fail(
                        "too-large",
                        "ops: the whole batch is larger than the configured limit; no file was written",
                    );
                }

                entries.push({
                    path: canonical,
                    segments,
                    tool: input.tool,
                    final,
                    finalHash: sha256(final),
                    parentStat: parent.stat,
                    target,
                });
                existingHandle = undefined;
            } catch (error) {
                await existingHandle?.close().catch(() => {});
                await parent.handle.close().catch(() => {});

                throw error;
            }
        }

        return { entries, scope: input.scope, limit };
    } catch (error) {
        await closeMutationPlan({ entries, scope: input.scope, limit });

        throw error;
    }
}

/** Recheck cwd, roots, parent identities, target identities, and original content. */
export async function revalidateMutationPlan(
    plan: MutationPlan,
    signal: AbortSignal | undefined,
): Promise<void> {
    checkAbort(signal);

    const cwd = await canonicalCwd(plan.scope.cwd);
    const cwdStat = await directoryIdentity(plan.scope.cwd);

    if (
        cwd !== plan.scope.cwd ||
        cwdStat.dev !== plan.scope.cwdStat.dev ||
        cwdStat.ino !== plan.scope.cwdStat.ino ||
        !isInside(cwd, plan.scope.root)
    ) {
        fail("changed", "ops: the session folder changed; no file was written");
    }

    for (const entry of plan.entries) {
        await revalidateEntry(entry, plan, signal);
    }
}

/** Write every file in order; stop at the first failure and report which entries were touched. */
export async function executeMutationPlan(
    plan: MutationPlan,
    signal: AbortSignal,
    observer?: MutationExecutionObserver,
): Promise<ExecutionResult> {
    const failures = new Map<number, OpsError>();
    const touched = new Set<number>();

    for (let index = 0; index < plan.entries.length; index++) {
        const entry = plan.entries[index]!;

        try {
            await revalidateEntry(entry, plan, signal);
        } catch (error) {
            failures.set(index, asOpsError(error));
            break;
        }

        if (observer !== undefined) {
            try {
                await observer.start(index);
            } catch (error) {
                failures.set(index, asOpsError(error));
                break;
            }
        }

        try {
            touched.add(index);

            if (entry.target.kind === "existing") {
                await writeExisting(entry, plan.limit, signal);
            } else {
                await writeNew(entry, plan.scope, plan.limit, signal);
            }

            if (observer !== undefined) {
                await observer.written(index);
            }
        } catch (error) {
            failures.set(index, asOpsError(error));
            break;
        }
    }

    return { failures, touched };
}

function rollbackFailure(code: string, message: string): RollbackOutcome {
    return { status: "rollback_failed", safe: false, error: { code, message } };
}

async function restoreExisting(entry: MutationPlanEntry, limit: number): Promise<RollbackOutcome> {
    const target = entry.target;

    if (target.kind !== "existing") {
        return { status: "not_written", safe: true };
    }

    if (entry.afterWrite === undefined) {
        return rollbackFailure(
            "rollback_state",
            "ops: no post-write state was recorded; the file was not restored",
        );
    }

    let current;

    try {
        current = await readSnapshot(target.handle, limit, undefined);
    } catch {
        return rollbackFailure(
            "rollback_read",
            "ops: the written file could not be read; it was not restored",
        );
    }

    if (current.hash !== entry.afterWrite.hash || current.buffer.length !== entry.afterWrite.size) {
        return rollbackFailure(
            "changed",
            "ops: the file changed after the write; it was not overwritten by rollback",
        );
    }

    try {
        await target.handle.truncate(0);
        await writeAll(target.handle, target.original);
        await target.handle.truncate(target.original.length);
        await target.handle.sync();
        await target.handle.chmod(target.stat.mode & 0o7777);
    } catch {
        return rollbackFailure(
            "rollback_write",
            "ops: restoring the original bytes failed; the file may be partial",
        );
    }

    let restored;

    try {
        restored = await readSnapshot(target.handle, limit, undefined);

        const after = statKey(await target.handle.stat({ bigint: true }));

        if (
            restored.hash !== target.originalHash ||
            restored.buffer.length !== target.original.length ||
            after.size !== target.original.length ||
            after.dev !== target.stat.dev ||
            after.ino !== target.stat.ino ||
            after.nlink !== 1 ||
            (after.mode & 0o7777) !== (target.stat.mode & 0o7777)
        ) {
            return rollbackFailure(
                "rollback_verify",
                "ops: the restored file did not verify; it may be partial",
            );
        }

        await verifyEntry(target.parent, target.name, target.stat);
    } catch {
        return rollbackFailure(
            "rollback_verify",
            "ops: the restored file did not verify; it may be partial",
        );
    }

    return { status: "restored", safe: true };
}

async function removeNew(entry: MutationPlanEntry): Promise<RollbackOutcome> {
    const target = entry.target;

    if (target.kind !== "new") {
        return { status: "not_written", safe: true };
    }

    if (target.created === undefined) {
        return { status: "not_written", safe: true };
    }

    if (target.createdStat === undefined) {
        return rollbackFailure(
            "uncertain",
            "ops: a new file was created but its identity was not verified; it was kept and may exist",
        );
    }

    let current;

    try {
        current = statKey(await target.created.stat({ bigint: true }));
    } catch {
        return rollbackFailure(
            "uncertain",
            "ops: the created file could not be checked; it was kept and may exist",
        );
    }

    if (current.dev !== target.createdStat.dev || current.ino !== target.createdStat.ino) {
        return rollbackFailure(
            "changed",
            "ops: the bound new-file inode changed; the path was not removed",
        );
    }

    if (current.nlink === 0) {
        return { status: "restored", safe: true };
    }

    return rollbackFailure(
        "kept",
        "ops: the new file was kept because removing it by path could delete a third-party replacement",
    );
}

/** Best-effort rollback of every touched entry. Never touches a path that is not the bound inode. */
export async function rollbackMutationPlan(
    plan: MutationPlan,
    touched: ReadonlySet<number>,
): Promise<ReadonlyMap<number, RollbackOutcome>> {
    const outcomes = new Map<number, RollbackOutcome>();
    const indexes = [...touched].sort((left, right) => right - left);

    for (const index of indexes) {
        const entry = plan.entries[index];

        if (entry === undefined) {
            continue;
        }

        try {
            outcomes.set(
                index,
                entry.target.kind === "existing"
                    ? await restoreExisting(entry, plan.limit)
                    : await removeNew(entry),
            );
        } catch {
            outcomes.set(
                index,
                rollbackFailure("rollback", "ops: rollback failed safely; verify the file"),
            );
        }
    }

    return outcomes;
}

/** Close every descriptor held by a plan. Safe to call more than once. */
export async function closeMutationPlan(plan: MutationPlan): Promise<void> {
    for (const entry of plan.entries) {
        if (entry.target.kind === "existing") {
            await entry.target.handle.close().catch(() => {});
        } else if (entry.target.created !== undefined) {
            await entry.target.created.close().catch(() => {});
        }

        await entry.target.parent.close().catch(() => {});
    }
}
