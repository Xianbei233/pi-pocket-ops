/** ops_read and the read side of ops_result: exact UTF-8 page boundaries and snapshot-bound continuation. */

import type { Config, Cursor, OpsHost, Page, ScanShare, Scope } from "./types.ts";
import { effectiveBudget, tokenEstimate } from "./budget.ts";
import { fail, OpsError, throwIfAborted } from "./errors.ts";
import {
    estimateSnapshotBytes,
    handleMiss,
    type Entry,
    type HandleStore,
    type ReadOrigin,
    type ReadSnapshot,
} from "./handles.ts";
import { readRegular } from "./fs-safe.ts";
import { relativeSegments, sameStat } from "./paths.ts";
import { assertRequester, verifyScope } from "./scope.ts";
import {
    type Attr,
    byteLength,
    envelope,
    minimalError,
    NOTE_READ,
    shortEnvelope,
    utf8Prefix,
} from "./render.ts";

const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;
const MAX_PATH_CHARS = 4_096;

export interface ReadArgs {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly maxBytes?: number;
    readonly maxTokens?: number;
    readonly fresh?: boolean;
}

interface ReadRequest {
    readonly segments: string[];
    readonly path: string;
    readonly offset: number;
    readonly limit: number;
}

/** The request identity and effective budget used by the session-dedup key. */
export interface ReadIdentity extends ReadRequest {
    readonly budget: number;
}

function parseRead(args: ReadArgs): ReadRequest {
    const segments = relativeSegments(args.path, MAX_PATH_CHARS);
    const offset = args.offset ?? 1;
    const limit = args.limit ?? DEFAULT_LINES;

    if (!Number.isSafeInteger(offset) || offset < 1 || offset > 1_000_000_000) {
        fail("offset", "ops: offset must be a positive line number");
    }

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LINES) {
        fail("limit", `ops: limit must be an integer between 1 and ${MAX_LINES}`);
    }

    return { segments, path: segments.join("/"), offset, limit };
}

interface LineBounds {
    readonly contentEnd: number;
    readonly nextStart: number;
    readonly hasNext: boolean;
}

function lineBounds(buffer: Buffer, start: number): LineBounds {
    let end = start;

    while (end < buffer.length && buffer[end] !== 0x0a) {
        end++;
    }

    const nextStart = end < buffer.length ? end + 1 : buffer.length;
    const hasNext = end < buffer.length && nextStart < buffer.length;
    const contentEnd = end > start && buffer[end - 1] === 0x0d ? end - 1 : end;

    return { contentEnd, nextStart, hasNext };
}

/** The absolute start of a 1-based line, or undefined past the end. */
function findLineStart(buffer: Buffer, line: number): number | undefined {
    if (line === 1) {
        return buffer.length === 0 ? undefined : 0;
    }

    let current = 1;

    for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] === 0x0a) {
            current++;

            if (current === line) {
                const start = index + 1;

                return start < buffer.length ? start : undefined;
            }
        }
    }

    return undefined;
}

interface ComposeResult {
    readonly body: string;
    readonly cursor: Cursor;
    readonly done: boolean;
    readonly truncated: boolean;
    readonly fileDone: boolean;
    readonly lines: number;
}

/** Compose up to endLine from cursor, within a content-byte budget, never splitting a code point. */
function composeBody(
    buffer: Buffer,
    start: Cursor,
    endLine: number,
    contentBudget: number,
): ComposeResult {
    if (buffer.length === 0) {
        return { body: "", cursor: start, done: true, truncated: false, fileDone: true, lines: 0 };
    }

    const firstStart = findLineStart(buffer, start.line);

    if (firstStart === undefined) {
        return { body: "", cursor: start, done: true, truncated: false, fileDone: true, lines: 0 };
    }

    const pieces: string[] = [];
    let bytes = 0;
    let lines = 0;
    let cursor: Cursor = { line: start.line, byte: Math.max(start.byte, firstStart) };
    let lineStart = firstStart;
    let done = false;
    let fileDone = false;
    let truncated = false;

    while (cursor.line <= endLine) {
        const bounds = lineBounds(buffer, lineStart);
        const dataStart = Math.max(cursor.byte, lineStart);

        if (dataStart > bounds.contentEnd) {
            if (!bounds.hasNext) {
                fileDone = true;
                done = true;
                break;
            }

            cursor = { line: cursor.line + 1, byte: bounds.nextStart };
            lineStart = bounds.nextStart;

            if (cursor.line > endLine) {
                done = true;
            }

            continue;
        }

        const prefix =
            dataStart === lineStart
                ? `${cursor.line}|`
                : `${cursor.line}@${dataStart - lineStart}|`;
        const data = buffer.subarray(dataStart, bounds.contentEnd);
        const separator = pieces.length === 0 ? 0 : 1;
        const available = contentBudget - bytes - separator - byteLength(prefix);

        if (available <= 0) {
            truncated = true;
            break;
        }

        if (available >= data.length) {
            const text = `${prefix}${data.toString("utf8")}`;

            pieces.push(text);
            bytes += separator + byteLength(text);
            lines++;

            if (!bounds.hasNext) {
                fileDone = true;
                done = true;
                break;
            }

            if (cursor.line >= endLine) {
                done = true;
                break;
            }

            cursor = { line: cursor.line + 1, byte: bounds.nextStart };
            lineStart = bounds.nextStart;
            continue;
        }

        const partial = utf8Prefix(data.toString("utf8"), available);

        if (partial.length === 0) {
            truncated = true;
            break;
        }

        const text = `${prefix}${partial}`;

        pieces.push(text);
        bytes += separator + byteLength(text);
        lines++;
        cursor = { line: cursor.line, byte: dataStart + byteLength(partial) };
        truncated = true;
        break;
    }

    if (cursor.line > endLine) {
        done = true;
    }

    return {
        body: pieces.join("\n"),
        cursor,
        done,
        truncated: !done && truncated,
        fileDone,
        lines,
    };
}

interface ReadMeta {
    readonly path: string;
    readonly ref: string;
    readonly size: number;
    readonly hash: string;
    readonly line: number;
    readonly windowEnd: number;
    readonly budget: number;
    readonly done: boolean;
    readonly truncated: boolean;
    readonly handle?: string;
    readonly nextOffset?: number;
}

function renderRead(host: OpsHost, meta: ReadMeta, body: string): string {
    const attrs: Attr[] = [
        ["path", meta.path],
        ["ref", meta.ref],
        ["bytes", meta.size],
        ["hash", `sha256:${meta.hash.slice(0, 16)}`],
        ["line", meta.line],
        ["window_end", meta.windowEnd],
        ["budget", meta.budget],
        ["tokens_budget_est", tokenEstimate(meta.budget)],
        ["done", meta.done],
        ["truncated", meta.truncated],
        ["handle", meta.handle],
        ["next_offset", meta.nextOffset],
        ["next_kind", meta.nextOffset === undefined ? undefined : "new-range"],
    ];

    return envelope(host, "ops_read", attrs, body, NOTE_READ);
}

function readOverhead(host: OpsHost, meta: ReadMeta): number {
    return byteLength(
        renderRead(
            host,
            {
                ...meta,
                done: false,
                truncated: true,
                handle: "0".repeat(48),
                nextOffset: 999_999_999,
            },
            "",
        ),
    );
}

interface ReadPage extends Page {
    readonly cursor?: Cursor;
}

type HandleMode = "create" | "reuse" | "none";

async function buildReadPage(
    host: OpsHost,
    scope: Scope,
    store: HandleStore,
    snapshotBase: Omit<ReadSnapshot, "cursor" | "endLine">,
    buffer: Buffer,
    start: Cursor,
    endLine: number,
    budget: number,
    mode: HandleMode,
    existingHandle?: string,
    created?: Set<string>,
): Promise<ReadPage> {
    const metaBase: ReadMeta = {
        path: snapshotBase.path,
        ref: snapshotBase.ref,
        size: snapshotBase.stat.size,
        hash: snapshotBase.hash,
        line: start.line,
        windowEnd: endLine,
        budget,
        done: false,
        truncated: true,
    };
    const overhead = readOverhead(host, metaBase);

    if (budget <= overhead + 16) {
        return {
            text: minimalError(host, "ops_read", "ops: page budget is too small", budget),
            done: false,
        };
    }

    const initial = Math.max(0, budget - overhead - 16);
    let low = 0;
    let high = initial;
    let best:
        | { readonly composed: ComposeResult; readonly body: string; readonly text: string }
        | undefined;

    for (let attempt = 0; attempt < 16 && low <= high; attempt++) {
        const mid = Math.floor((low + high) / 2);
        const candidate = composeBody(buffer, start, endLine, mid);

        if (!candidate.done && candidate.body.length === 0) {
            high = mid - 1;
            continue;
        }

        const body = host.text.defang(candidate.body);
        const nextOffset = candidate.done && !candidate.fileDone ? endLine + 1 : undefined;
        const text = renderRead(
            host,
            {
                ...metaBase,
                done: candidate.done,
                truncated: candidate.truncated,
                nextOffset,
                handle: candidate.done ? undefined : "0".repeat(48),
            },
            body,
        );

        if (byteLength(text) <= budget) {
            best = { composed: candidate, body, text };
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    if (best === undefined) {
        return {
            text: minimalError(host, "ops_read", "ops: page budget is too small", budget),
            done: false,
        };
    }

    const composed = best.composed;
    const body = best.body;
    let rendered = best.text;

    if (composed.done) {
        const nextOffset = composed.fileDone ? undefined : endLine + 1;
        const origin: ReadOrigin = {
            kind: "read",
            snapshot: { ...snapshotBase, cursor: start, endLine },
            start,
            budget,
            complete: true,
        };

        return {
            text: rendered,
            done: true,
            nextOffset,
            cursor: composed.cursor,
            origin,
        };
    }

    if (composed.body.length === 0) {
        return {
            text: minimalError(host, "ops_read", "ops: page budget is too small", budget),
            done: false,
        };
    }

    await verifyScope(host, scope);

    let handle = existingHandle;

    if (mode === "create") {
        const snapshot: ReadSnapshot = { ...snapshotBase, cursor: composed.cursor, endLine };

        handle = store.create(snapshot, estimateSnapshotBytes(snapshot));

        if (handle !== undefined) {
            created?.add(handle);
        }

        if (handle === undefined) {
            return {
                text: minimalError(
                    host,
                    "ops_read",
                    "ops: page cache limit reached; retry later",
                    budget,
                ),
                done: false,
            };
        }
    }

    if (handle === undefined) {
        return {
            text: minimalError(host, "ops_read", "ops: page handle is unavailable", budget),
            done: false,
        };
    }

    const withHandle = renderRead(
        host,
        { ...metaBase, done: false, truncated: true, handle },
        body,
    );

    if (byteLength(withHandle) > budget) {
        if (mode === "create") {
            store.delete(handle);
        }

        return {
            text: minimalError(host, "ops_read", "ops: page budget is too small", budget),
            done: false,
        };
    }

    assertRequester(host, scope);

    const origin: ReadOrigin = {
        kind: "read",
        snapshot: { ...snapshotBase, cursor: start, endLine },
        start,
        budget,
        complete: false,
    };

    return { text: withHandle, handle, done: false, cursor: composed.cursor, origin };
}

function shortRead(host: OpsHost, attrs: readonly Attr[], message: string, budget: number): string {
    const text = shortEnvelope(host, "ops_read", attrs, message);

    return byteLength(text) <= budget ? text : minimalError(host, "ops_read", message, budget);
}

export function readIdentity(args: ReadArgs, config: Config): ReadIdentity {
    const request = parseRead(args);

    return { ...request, budget: effectiveBudget(args, config.limits.maxOutputBytes) };
}

export async function opsRead(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    args: ReadArgs,
    share?: ScanShare,
    created?: Set<string>,
): Promise<Page> {
    assertRequester(host, scope);

    const request = parseRead(args);
    const budget = effectiveBudget(args, config.limits.maxOutputBytes);
    let readLimit = config.limits.maxFileBytes;

    if (share !== undefined) {
        const remaining = config.limits.maxScanBytes - share.bytes;

        if (remaining <= 0) {
            share.truncated = true;
            fail("limit", "ops: batch scan limit reached");
        }

        readLimit = Math.min(readLimit, remaining);

        if (share.entries >= config.limits.maxScanEntries) {
            share.truncated = true;
            fail("limit", "ops: batch scan entry limit reached");
        }

        share.entries += 1;
    }

    let file;
    let charged = 0;

    try {
        file = await readRegular(
            scope,
            request.segments,
            readLimit,
            scope.signal,
            share === undefined
                ? undefined
                : (bytes) => {
                      charged += bytes;
                      share.bytes += bytes;
                  },
        );
    } catch (error) {
        if (share !== undefined) {
            // A low-level read can consume bytes and then throw before the callback sees them. Charge the rest of
            // the attempted cap so repeated failures cannot bypass the shared budget.
            const rest = Math.max(0, readLimit - charged);

            share.bytes += rest;

            if (rest > 0 || (error instanceof OpsError && error.code === "changed")) {
                share.truncated = true;
            }
        }

        throw error;
    }

    if (file.buffer.includes(0)) {
        fail("binary", "ops: invalid file: binary data (NUL byte) is not read as text");
    }

    let text: string;

    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.buffer);
    } catch {
        fail("encoding", "ops: invalid file: not valid UTF-8 text");
    }

    if (byteLength(text) !== file.buffer.length) {
        fail("encoding", "ops: invalid file: not valid UTF-8 text");
    }

    const endLine = request.offset + request.limit - 1;
    const ref = `sha256:${file.hash.slice(0, 16)}`;
    const snapshotBase: Omit<ReadSnapshot, "cursor" | "endLine"> = {
        kind: "read",
        conversationId: scope.conversationId,
        requester: scope.requester,
        cwd: scope.cwd,
        root: scope.root,
        cwdStat: scope.cwdStat,
        segments: request.segments,
        path: request.path,
        ref,
        stat: file.stat,
        hash: file.hash,
    };
    const start = findLineStart(file.buffer, request.offset);

    if (start === undefined) {
        await verifyScope(host, scope);
        assertRequester(host, scope);
        throwIfAborted(scope.signal);

        return {
            text: shortRead(
                host,
                [
                    ["path", request.path],
                    ["ref", ref],
                    ["line", request.offset],
                    ["window_end", endLine],
                    ["budget", budget],
                    ["tokens_budget_est", tokenEstimate(budget)],
                    ["done", true],
                ],
                file.buffer.length === 0
                    ? "ops: file is empty"
                    : "ops: offset is past the end of the file",
                budget,
            ),
            done: true,
        };
    }

    const page = await buildReadPage(
        host,
        scope,
        store,
        snapshotBase,
        file.buffer,
        { line: request.offset, byte: start },
        endLine,
        budget,
        "create",
        undefined,
        created,
    );

    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    return page;
}

/** Continue a read handle. The stored snapshot is revalidated before any bytes are returned. */
export async function resumeRead(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    entry: Entry,
    args: { readonly maxBytes?: number; readonly maxTokens?: number },
): Promise<Page> {
    const snapshot = entry.snapshot;

    if (snapshot.kind !== "read") {
        return handleMiss();
    }

    if (
        snapshot.root !== scope.root ||
        snapshot.cwd !== scope.cwd ||
        snapshot.cwdStat.dev !== scope.cwdStat.dev ||
        snapshot.cwdStat.ino !== scope.cwdStat.ino
    ) {
        return handleMiss();
    }

    await verifyScope(host, scope);

    const budget = effectiveBudget(args, config.limits.maxOutputBytes);
    let file;

    try {
        file = await readRegular(
            scope,
            snapshot.segments,
            config.limits.maxFileBytes,
            scope.signal,
        );
    } catch (error) {
        if (
            error instanceof OpsError &&
            (error.code === "timeout" || error.code === "cancelled" || error.code === "disposed")
        ) {
            throw error;
        }

        store.delete(entry.handle);

        return handleMiss();
    }

    if (!sameStat(snapshot.stat, file.stat) || snapshot.hash !== file.hash) {
        store.delete(entry.handle);

        return handleMiss();
    }

    const page = await buildReadPage(
        host,
        scope,
        store,
        {
            kind: "read",
            conversationId: snapshot.conversationId,
            requester: snapshot.requester,
            cwd: snapshot.cwd,
            root: snapshot.root,
            cwdStat: snapshot.cwdStat,
            segments: snapshot.segments,
            path: snapshot.path,
            ref: snapshot.ref,
            stat: snapshot.stat,
            hash: snapshot.hash,
        },
        file.buffer,
        snapshot.cursor,
        snapshot.endLine,
        budget,
        "reuse",
        entry.handle,
    );

    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    if (page.done) {
        store.delete(entry.handle);

        return { text: page.text, done: true, nextOffset: page.nextOffset };
    }

    if (page.cursor !== undefined) {
        const next: ReadSnapshot = { ...snapshot, cursor: page.cursor };

        if (!store.update(entry.handle, next)) {
            return handleMiss();
        }

        store.touch(entry.handle);
    }

    return { text: page.text, handle: page.handle ?? entry.handle, done: false };
}
