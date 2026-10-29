/**
 * Draft-only Ops 0.3.4 query output surface. This file is not imported by the 0.3.3 root release.
 *
 * It recognizes a deliberately narrow, single-clause query command and captures the exact bytes the host
 * delivers through api.output. It never builds a shell command, never executes anything, and never makes a
 * read-only or path-permission claim.
 */

import { randomBytes } from "node:crypto";

export const QUERY_MAX_CAPTURE_BYTES = 262_144;
export const QUERY_SNAPSHOT_TTL_MS = 900_000;
export const HOST_MAX_OUTPUT_BYTES = 50 * 1024;
export const HOST_MAX_OUTPUT_LINES = 2_000;

export const BASH_OBSERVER = Symbol.for("pi-pocket.bash-observer.v1");

export interface BashObserverCapability {
    readonly protocol: 1;
    readonly extension: "pi-pocket-tool-gate";
    readonly capability: "observe-only";
    readonly target: "bash";
}

export type QueryExecutable = "rg" | "grep" | "stat" | "wc" | "ls";

export interface QueryMatch {
    readonly executable: QueryExecutable;
    readonly flags: readonly string[];
    readonly operands: readonly string[];
    readonly cwd?: string;
}

export interface QueryCapture {
    readonly text: string;
    readonly bytes: number;
    readonly lines: number;
    readonly skippedBytes: number;
    readonly skippedLines: number;
    readonly complete: boolean;
    readonly nestedSafe: boolean;
    readonly reason?:
        "skipped" | "diagnostic" | "cap" | "encoding" | "chunk" | "host-limit" | "sanitize";
}

export interface QuerySnapshotIdentity {
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
    readonly configRevision: string;
}

export interface QuerySnapshotLimits {
    readonly maxHandles: number;
    readonly maxHandlesPerScope: number;
    readonly handleTtlMs: number;
    readonly maxHandleBytes: number;
    readonly maxTotalBytes: number;
}

export interface QueryOutputSnapshot {
    readonly kind: "bash-output";
    readonly version: 1;
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
    readonly configRevision: string;
    readonly sourceCallId: string;
    readonly text: string;
    readonly offset: number;
}

export interface QueryPage {
    readonly text: string;
    readonly handle?: string;
    readonly done: boolean;
    readonly nextOffset?: number;
    readonly error?: "budget";
    readonly reason?: "complete" | "budget" | "cache";
}

export interface QuerySnapshotLease {
    readonly handle: string;
    readonly token: string;
    readonly identity: QuerySnapshotIdentity;
    readonly snapshot: QueryOutputSnapshot;
}

/** Display-only snapshot API; it has no execute/replay/command lookup method. */
export interface QuerySnapshotStore {
    put(snapshot: QueryOutputSnapshot): string | undefined;
    get(handle: string, identity: QuerySnapshotIdentity): QueryOutputSnapshot | undefined;
    claim(handle: string, identity: QuerySnapshotIdentity): QuerySnapshotLease | undefined;
    advance(lease: QuerySnapshotLease, offset: number): boolean;
    release(lease: QuerySnapshotLease): void;
    delete(handle: string): void;
    deleteScope(identity: QuerySnapshotIdentity): number;
    dispose(): void;
}

const FIXED_FLAGS: Readonly<Record<QueryExecutable, ReadonlySet<string>>> = {
    rg: new Set(["-n", "--no-heading", "--color=never", "--no-messages"]),
    grep: new Set(["-n", "-F", "-E", "--color=never"]),
    stat: new Set(["-c"]),
    wc: new Set(["-l", "-c"]),
    ls: new Set(["-l", "--color=never"]),
};

const EXECUTABLES = new Set<QueryExecutable>(["rg", "grep", "stat", "wc", "ls"]);
const FORBIDDEN = [
    ";",
    "&",
    "|",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "`",
    "$",
    "\\",
    "'",
    '"',
    "*",
    "?",
    "[",
    "]",
    "~",
    "!",
    "\n",
    "\r",
    "\0",
];
const INVALID_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/u;

function shellFreeOperand(token: string): boolean {
    return token.length > 0 && !token.startsWith("-") && !token.includes("=");
}

/**
 * Match only one simple argv clause. This is not safe-command authorization: the original command still
 * executes under its ordinary PATH, aliases, environment, filesystem, and Guard.
 */
export function matchQueryCommand(command: unknown): QueryMatch | undefined {
    if (typeof command !== "string" || command.trim() === "" || command.trim() !== command) {
        return undefined;
    }

    if (FORBIDDEN.some((character) => command.includes(character)) || !command.isWellFormed()) {
        return undefined;
    }

    // POSIX shell word separators here are ASCII space/tab only. Other Unicode spaces,
    // controls, bidi/format characters, and line separators are not silently re-split.
    const normalizedSeparators = command.replaceAll("\t", " ");

    if (
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalizedSeparators) ||
        /\p{Zs}/u.test(normalizedSeparators.replaceAll(" ", ""))
    ) {
        return undefined;
    }

    const tokens = command.split(/[ \t]+/u);

    if (tokens.length === 0 || !tokens.every((token) => token.length > 0)) {
        return undefined;
    }

    const executable = tokens[0] as QueryExecutable;

    if (!EXECUTABLES.has(executable)) {
        return undefined;
    }

    const flags: string[] = [];
    const operands: string[] = [];
    let operandStarted = false;

    for (const token of tokens.slice(1)) {
        if (token.startsWith("-")) {
            if (operandStarted || !FIXED_FLAGS[executable].has(token) || flags.includes(token)) {
                return undefined;
            }

            flags.push(token);
            continue;
        }

        if (!shellFreeOperand(token)) {
            return undefined;
        }

        operandStarted = true;
        operands.push(token);
    }

    if (executable === "grep" && operands.length < 2) {
        return undefined;
    }

    if (executable === "rg" && operands.length < 1) {
        return undefined;
    }

    if (executable === "stat" && (flags.length !== 1 || flags[0] !== "-c" || operands.length < 2)) {
        return undefined;
    }

    if (executable === "wc" && operands.length < 1) {
        return undefined;
    }

    if (executable === "ls" && operands.length > 1) {
        return undefined;
    }

    return { executable, flags, operands };
}

/**
 * Capture exact output chunks delivered by api.output. The second argument is ShellOutputSkip, not a number.
 * Unknown skip shapes are incomplete; the original second argument is always forwarded unchanged outside this
 * pure capture.
 */
export class QueryOutputCapture {
    private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    private text = "";
    private started = false;
    private skippedBytes = 0;
    private skippedLines = 0;
    private sawBytes = false;
    private sawStrings = false;
    private bomSeen = false;
    private decoderTail = false;
    private complete = true;
    private reason: QueryCapture["reason"];

    output(chunk: unknown, skipped?: unknown): void {
        if (!this.complete) {
            return;
        }

        if (!this.acceptSkip(skipped)) {
            return;
        }

        let value: string;

        try {
            if (typeof chunk === "string") {
                this.sawStrings = true;

                if (chunk.startsWith("\ufeff")) {
                    this.bomSeen = true;
                }

                value = this.decoder.decode() + chunk;
            } else if (chunk instanceof Uint8Array) {
                this.sawBytes = true;
                // OutputBuffer flushes pending bytes only for a string or a skipped chunk;
                // a plain byte chunk must remain a streaming decode.
                const pending = skipped === undefined ? "" : this.decoder.decode();
                const decoded = this.decoder.decode(chunk, { stream: true });

                value = pending + decoded;

                // Match OutputBuffer: drop a BOM only at the start of the first byte chunk.
                if (!this.started && pending === "" && value.startsWith("\ufeff")) {
                    this.bomSeen = true;
                    value = value.slice(1);
                } else if (value.includes("\ufeff")) {
                    this.bomSeen = true;
                }
            } else {
                this.fail("chunk");

                return;
            }
        } catch {
            this.fail("chunk");

            return;
        }

        if (!this.started && (value !== "" || skipped !== undefined)) {
            this.started = true;
        }

        this.text += value;

        if (Buffer.byteLength(this.text, "utf8") > QUERY_MAX_CAPTURE_BYTES) {
            this.fail("cap");
        }
    }

    /** The integration uses this if an observer call throws; the original output still forwards. */
    invalidate(reason: NonNullable<QueryCapture["reason"]> = "chunk"): void {
        this.fail(reason);
    }

    diagnostic(diagnostic: unknown): void {
        if (!this.complete || typeof diagnostic !== "object" || diagnostic === null) {
            return;
        }

        const record = diagnostic as { readonly code?: unknown; readonly message?: unknown };
        const message = typeof record.message === "string" ? record.message : "";

        if (
            record.code === "full_output" ||
            record.code === "truncated" ||
            /full output|spill|truncat/iu.test(message)
        ) {
            this.fail("diagnostic");
        }
    }

    finish(): QueryCapture {
        if (this.complete) {
            const tail = this.decoder.decode();

            if (tail !== "") {
                this.text += tail;
                this.decoderTail = true;
            }
        }

        const bytes = Buffer.byteLength(this.text, "utf8");
        const lines =
            this.text === ""
                ? 0
                : (this.text.match(/\n/gu)?.length ?? 0) + (this.text.endsWith("\n") ? 0 : 1);

        if (this.complete && INVALID_OUTPUT.test(this.text)) {
            this.fail("sanitize");
        }

        if (this.complete && (bytes > HOST_MAX_OUTPUT_BYTES || lines > HOST_MAX_OUTPUT_LINES)) {
            this.fail("host-limit");
        }

        if (!this.complete) {
            return {
                text: "",
                bytes,
                lines,
                skippedBytes: this.skippedBytes,
                skippedLines: this.skippedLines,
                complete: false,
                nestedSafe: false,
                reason: this.reason,
            };
        }

        return {
            text: this.text,
            bytes,
            lines,
            skippedBytes: this.skippedBytes,
            skippedLines: this.skippedLines,
            complete: true,
            nestedSafe: !this.decoderTail && (!this.sawBytes || !this.sawStrings) && !this.bomSeen,
            reason: undefined,
        };
    }

    private acceptSkip(skipped: unknown): boolean {
        if (skipped === undefined) {
            return true;
        }

        // Only an explicit numeric zero is a no-op; NaN, negative, infinite, or positive is malformed.
        if (typeof skipped === "number") {
            if (skipped !== 0) {
                if (Number.isFinite(skipped) && skipped > 0) {
                    this.skippedBytes += skipped;
                }

                this.fail("skipped");

                return false;
            }

            this.started = true;

            return true;
        }

        if (typeof skipped !== "object" || skipped === null) {
            this.fail("skipped");

            return false;
        }

        const record = skipped as {
            readonly bytes?: unknown;
            readonly newlines?: unknown;
            readonly lines?: unknown;
            readonly endsWithNewline?: unknown;
        };
        const bytes = record.bytes;
        const lines = record.newlines ?? record.lines;

        if (
            typeof bytes !== "number" ||
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            typeof lines !== "number" ||
            !Number.isSafeInteger(lines) ||
            lines < 0 ||
            typeof record.endsWithNewline !== "boolean"
        ) {
            this.fail("skipped");

            return false;
        }

        this.skippedBytes += bytes;
        this.skippedLines += lines;
        this.started = true;

        if (bytes > 0 || lines > 0) {
            this.fail("skipped");

            return false;
        }

        return true;
    }

    private fail(reason: NonNullable<QueryCapture["reason"]>): void {
        if (this.complete) {
            this.complete = false;
            this.reason = reason;
        }
    }
}

function validIdentityPart(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.isWellFormed();
}

function validCwdIdentity(dev: unknown, ino: unknown): boolean {
    return typeof dev === "string" && dev.length > 0 && typeof ino === "string" && ino.length > 0;
}

function validOffset(text: string, offset: unknown): offset is number {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        return false;
    }

    const buffer = Buffer.from(text, "utf8");

    return (
        offset <= buffer.length && (offset === buffer.length || (buffer[offset]! & 0xc0) !== 0x80)
    );
}

function validSnapshotText(text: unknown): text is string {
    return (
        typeof text === "string" &&
        text.isWellFormed() &&
        !INVALID_OUTPUT.test(text) &&
        !text.includes("\0")
    );
}

export function createOutputSnapshot(input: {
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
    readonly configRevision: string;
    readonly sourceCallId: string;
    readonly text: string;
    readonly offset: number;
}): QueryOutputSnapshot | undefined {
    if (
        !Number.isSafeInteger(input.conversationId) ||
        input.conversationId < 0 ||
        !validIdentityPart(input.requester) ||
        !validIdentityPart(input.cwd) ||
        !validCwdIdentity(input.cwdDev, input.cwdIno) ||
        !validIdentityPart(input.configRevision) ||
        !validIdentityPart(input.sourceCallId) ||
        !validSnapshotText(input.text) ||
        !validOffset(input.text, input.offset)
    ) {
        return undefined;
    }

    return {
        kind: "bash-output",
        version: 1,
        conversationId: input.conversationId,
        requester: input.requester,
        cwd: input.cwd,
        cwdDev: input.cwdDev,
        cwdIno: input.cwdIno,
        configRevision: input.configRevision,
        sourceCallId: input.sourceCallId,
        text: input.text,
        offset: input.offset,
    };
}

/**
 * A page shape for the root renderer. `budget` is the whole model-visible content budget, and
 * `overhead` is the exact bytes the root framing/note/hint will add. Never returns an empty cursor:
 * too little room is an explicit budget error.
 */
function countOutputLines(text: string): number {
    return text === "" ? 0 : (text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

function truncateAtLineLimit(text: string, maxLines: number): string {
    if (maxLines <= 0) {
        return "";
    }

    let lines = 0;

    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") {
            lines++;

            if (lines >= maxLines) {
                return text.slice(0, index + 1);
            }
        }
    }

    return text;
}

/**
 * A page shape for the root renderer. `budget` is the whole model-visible content budget;
 * `overheadBytes`/`overheadLines` are exact costs of tags/note/hint. The page body must also
 * fit the host tail limits; empty progress is an explicit budget error.
 */
export function pageCapture(
    capture: QueryCapture,
    options: {
        readonly budget: number;
        readonly overheadBytes?: number;
        readonly overheadLines?: number;
        readonly maxBytes?: number;
        readonly maxLines?: number;
        readonly handle?: string;
        readonly offset?: number;
    },
): QueryPage {
    if (!capture.complete) {
        return { text: "", done: true, reason: "complete" };
    }

    const budget = options.budget;
    const overheadBytes = options.overheadBytes ?? 0;
    const overheadLines = options.overheadLines ?? 0;
    const maxBytes = options.maxBytes ?? HOST_MAX_OUTPUT_BYTES;
    const maxLines = options.maxLines ?? HOST_MAX_OUTPUT_LINES;
    const offset = options.offset ?? 0;

    if (
        !Number.isSafeInteger(budget) ||
        budget <= 0 ||
        !Number.isSafeInteger(overheadBytes) ||
        overheadBytes < 0 ||
        !Number.isSafeInteger(overheadLines) ||
        overheadLines < 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        !Number.isSafeInteger(maxLines) ||
        maxLines <= 0
    ) {
        return { text: "", done: false, error: "budget", reason: "budget" };
    }

    const room = Math.min(budget, maxBytes) - overheadBytes;
    const allowedLines = maxLines - overheadLines;

    if (room <= 0 || allowedLines <= 0) {
        return { text: "", done: false, error: "budget", reason: "budget" };
    }

    const buffer = Buffer.from(capture.text, "utf8");

    if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) {
        return { text: "", done: false, error: "budget", reason: "budget" };
    }

    const rest = buffer.subarray(offset);

    if (rest.length <= room) {
        const whole = rest.toString("utf8");

        if (countOutputLines(whole) <= allowedLines) {
            return { text: whole, done: true, reason: "complete" };
        }
    }

    let cut = Math.min(room, rest.length);

    while (cut > 0 && (buffer[offset + cut]! & 0xc0) === 0x80) {
        cut--;
    }

    let piece = buffer.subarray(offset, offset + cut).toString("utf8");

    piece = truncateAtLineLimit(piece, allowedLines);

    if (piece === "") {
        return { text: "", done: false, error: "budget", reason: "budget" };
    }

    return {
        text: piece,
        handle: options.handle,
        done: false,
        nextOffset: offset + Buffer.byteLength(piece, "utf8"),
        reason: "budget",
    };
}

/** Reference bounded store for the draft. Integration may map this onto a new versioned HandleStore. */
export class MemoryQuerySnapshots implements QuerySnapshotStore {
    private readonly entries = new Map<
        string,
        { snapshot: QueryOutputSnapshot; expiresAt: number; busy?: string; bytes: number }
    >();
    private readonly limits: QuerySnapshotLimits;
    private totalBytes = 0;

    constructor(limits: QuerySnapshotLimits) {
        if (
            !Number.isSafeInteger(limits.maxHandles) ||
            limits.maxHandles <= 0 ||
            !Number.isSafeInteger(limits.maxHandlesPerScope) ||
            limits.maxHandlesPerScope <= 0 ||
            limits.maxHandlesPerScope > limits.maxHandles ||
            !Number.isSafeInteger(limits.handleTtlMs) ||
            limits.handleTtlMs <= 0 ||
            !Number.isSafeInteger(limits.maxHandleBytes) ||
            limits.maxHandleBytes <= 0 ||
            !Number.isSafeInteger(limits.maxTotalBytes) ||
            limits.maxTotalBytes < limits.maxHandleBytes
        ) {
            throw new RangeError("invalid query snapshot limits");
        }

        this.limits = limits;
    }

    put(snapshot: QueryOutputSnapshot): string | undefined {
        this.sweep();

        if (!this.validSnapshot(snapshot)) {
            return undefined;
        }

        const bytes = this.snapshotBytes(snapshot);

        if (bytes > this.limits.maxHandleBytes) {
            return undefined;
        }

        const scope = this.scopeKey(snapshot);
        let scopeCount = 0;

        for (const entry of this.entries.values()) {
            if (this.scopeKey(entry.snapshot) === scope) {
                scopeCount++;
            }
        }

        if (
            scopeCount >= this.limits.maxHandlesPerScope ||
            this.entries.size >= this.limits.maxHandles ||
            this.totalBytes + bytes > this.limits.maxTotalBytes
        ) {
            return undefined;
        }

        const handle = randomBytes(24).toString("hex");

        this.entries.set(handle, {
            snapshot: { ...snapshot },
            expiresAt: Date.now() + this.limits.handleTtlMs,
            bytes,
        });
        this.totalBytes += bytes;

        return handle;
    }

    get(handle: string, identity: QuerySnapshotIdentity): QueryOutputSnapshot | undefined {
        const entry = this.entries.get(handle);

        if (entry === undefined || Date.now() >= entry.expiresAt) {
            if (entry !== undefined) {
                this.drop(handle);
            }

            return undefined;
        }

        if (!this.sameScope(entry.snapshot, identity)) {
            // Wrong scope is a uniform miss and must not revoke the owner's handle.
            return undefined;
        }

        return { ...entry.snapshot };
    }

    claim(handle: string, identity: QuerySnapshotIdentity): QuerySnapshotLease | undefined {
        const entry = this.entries.get(handle);

        if (entry === undefined || entry.busy !== undefined || Date.now() >= entry.expiresAt) {
            if (entry !== undefined && Date.now() >= entry.expiresAt) {
                this.drop(handle);
            }

            return undefined;
        }

        if (!this.sameScope(entry.snapshot, identity)) {
            return undefined;
        }

        const token = randomBytes(16).toString("hex");

        entry.busy = token;

        return { handle, token, identity, snapshot: { ...entry.snapshot } };
    }

    advance(lease: QuerySnapshotLease, offset: number): boolean {
        const entry = this.entries.get(lease.handle);

        if (entry === undefined || entry.busy !== lease.token || Date.now() >= entry.expiresAt) {
            return false;
        }

        if (
            !this.sameScope(entry.snapshot, lease.identity) ||
            !validOffset(entry.snapshot.text, offset) ||
            offset <= entry.snapshot.offset
        ) {
            return false;
        }

        const oldBytes = entry.bytes;
        const next = { ...entry.snapshot, offset };
        const nextBytes = this.snapshotBytes(next);

        if (this.totalBytes - oldBytes + nextBytes > this.limits.maxTotalBytes) {
            return false;
        }

        entry.snapshot = next;
        entry.bytes = nextBytes;
        this.totalBytes += nextBytes - oldBytes;
        entry.busy = undefined;

        return true;
    }

    release(lease: QuerySnapshotLease): void {
        const entry = this.entries.get(lease.handle);

        if (entry?.busy === lease.token) {
            entry.busy = undefined;
        }
    }

    deleteScope(identity: QuerySnapshotIdentity): number {
        let deleted = 0;

        for (const [handle, entry] of this.entries) {
            if (this.sameScopeBase(entry.snapshot, identity)) {
                this.drop(handle);
                deleted++;
            }
        }

        return deleted;
    }

    delete(handle: string): void {
        this.drop(handle);
    }

    dispose(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    private validSnapshot(snapshot: QueryOutputSnapshot): boolean {
        return (
            snapshot.kind === "bash-output" &&
            snapshot.version === 1 &&
            Number.isSafeInteger(snapshot.conversationId) &&
            snapshot.conversationId >= 0 &&
            validIdentityPart(snapshot.requester) &&
            validIdentityPart(snapshot.cwd) &&
            validCwdIdentity(snapshot.cwdDev, snapshot.cwdIno) &&
            validIdentityPart(snapshot.configRevision) &&
            validIdentityPart(snapshot.sourceCallId) &&
            validSnapshotText(snapshot.text) &&
            validOffset(snapshot.text, snapshot.offset)
        );
    }

    private snapshotBytes(snapshot: QueryOutputSnapshot): number {
        return Buffer.byteLength(JSON.stringify(snapshot), "utf8") + 64;
    }

    private scopeKey(snapshot: QueryOutputSnapshot): string {
        return [
            snapshot.conversationId,
            snapshot.requester,
            snapshot.cwd,
            snapshot.cwdDev,
            snapshot.cwdIno,
        ].join("\u0000");
    }

    private sameScopeBase(snapshot: QueryOutputSnapshot, identity: QuerySnapshotIdentity): boolean {
        return (
            snapshot.conversationId === identity.conversationId &&
            snapshot.requester === identity.requester &&
            snapshot.cwd === identity.cwd &&
            snapshot.cwdDev === identity.cwdDev &&
            snapshot.cwdIno === identity.cwdIno
        );
    }

    private sameScope(snapshot: QueryOutputSnapshot, identity: QuerySnapshotIdentity): boolean {
        return (
            this.sameScopeBase(snapshot, identity) &&
            snapshot.configRevision === identity.configRevision
        );
    }

    private sweep(): void {
        const now = Date.now();

        for (const [handle, entry] of this.entries) {
            if (now >= entry.expiresAt) {
                this.drop(handle);
            }
        }
    }

    private drop(handle: string): void {
        const entry = this.entries.get(handle);

        if (entry !== undefined) {
            this.totalBytes -= entry.bytes;
            this.entries.delete(handle);
        }
    }
}
