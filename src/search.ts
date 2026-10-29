/** ops_search and the search side of ops_result: bounded, sorted, literal, snapshot-bound. */

import type { Config, OpsHost, Page, ScanShare, Scope } from "./types.ts";
import { effectiveBudget, tokenEstimate } from "./budget.ts";
import { fail, OpsError, throwIfAborted } from "./errors.ts";
import {
    estimateSnapshotBytes,
    handleMiss,
    type Entry,
    type HandleStore,
    type SearchDir,
    type SearchFile,
    type SearchOrigin,
    type SearchSnapshot,
} from "./handles.ts";
import {
    childStat,
    collectEntries,
    openChildDirectory,
    openDirectoryForScan,
    readChildRegular,
    readRegular,
    statDirectory,
    statRegular,
} from "./fs-safe.ts";
import { isScannableName, literalQuery, relativeSegments, sameStat, statKey } from "./paths.ts";
import { assertRequester, verifyScope } from "./scope.ts";
import {
    type Attr,
    byteLength,
    envelope,
    minimalError,
    NOTE_SEARCH,
    quoted,
    utf8Prefix,
} from "./render.ts";

const MAX_PATH_CHARS = 4_096;
const MAX_QUERY_CHARS = 512;

export interface SearchArgs {
    readonly path?: string;
    readonly query?: string;
    readonly mode?: "files" | "text";
    readonly maxBytes?: number;
    readonly maxTokens?: number;
    readonly fresh?: boolean;
}

interface SearchRequest {
    readonly segments: string[];
    readonly path: string;
    readonly mode: "files" | "text";
    readonly query: string;
}

/** The request identity and effective budget used by the session-dedup key. */
export interface SearchIdentity extends SearchRequest {
    readonly budget: number;
}

function parseSearch(args: SearchArgs): SearchRequest {
    const rawPath = args.path ?? ".";
    const segments = rawPath === "." ? [] : relativeSegments(rawPath, MAX_PATH_CHARS);
    const path = segments.length === 0 ? "." : segments.join("/");
    const hasQuery = typeof args.query === "string" && args.query.length > 0;
    const mode = args.mode ?? (hasQuery ? "text" : "files");

    if (mode !== "files" && mode !== "text") {
        fail("mode", "ops: mode must be files or text");
    }

    let query = "";

    if (mode === "text") {
        query = literalQuery(args.query, MAX_QUERY_CHARS);
    } else if (args.query !== undefined && args.query !== "") {
        query = literalQuery(args.query, MAX_QUERY_CHARS);
    }

    return { segments, path, mode, query };
}

interface ScanState {
    entries: number;
    bytes: number;
    matches: number;
    skipped: number;
    truncated: boolean;
    stop: boolean;
    depthTruncated: boolean;
}

interface Item {
    readonly key: string;
    readonly text: string;
}

function itemLine(
    host: OpsHost,
    path: string,
    line: number,
    text: string,
    maxLineBytes: number,
): string {
    const clipped =
        byteLength(text) > maxLineBytes ? `${utf8Prefix(text, maxLineBytes - 3)}...` : text;

    return `${quoted(host, path, 240)}:${line}|${clipped}`;
}

function fileItem(host: OpsHost, path: string, directory: boolean, size: number): string {
    return directory
        ? `d ${quoted(host, `${path}/`, 240)}`
        : `f ${quoted(host, path, 240)} ${size}`;
}

async function scanDirectory(
    host: OpsHost,
    config: Config,
    scope: Scope,
    request: SearchRequest,
    dir: Awaited<ReturnType<typeof openDirectoryForScan>>,
    segments: readonly string[],
    depth: number,
    state: ScanState,
    dirs: SearchDir[],
    files: SearchFile[],
    items: Item[],
): Promise<void> {
    const dirStat = statKey(await dir.handle.stat({ bigint: true }));

    dirs.push({ segments, path: dir.path, stat: dirStat });

    const remaining = config.limits.maxScanEntries - state.entries;

    if (remaining <= 0) {
        await dir.iterator.close().catch(() => {});
        state.truncated = true;

        return;
    }

    let batch;

    try {
        batch = await collectEntries(dir, remaining, scope.signal);
    } catch (error) {
        if (error instanceof OpsError && (error.code === "timeout" || error.code === "cancelled")) {
            throw error;
        }

        state.skipped++;
        state.truncated = true;

        return;
    }

    if (batch.more) {
        state.truncated = true;
    }

    for (const entry of batch.entries) {
        throwIfAborted(scope.signal);

        if (state.stop) {
            return;
        }

        // Every entry seen consumes the scan budget, including hidden and excluded names.
        state.entries++;

        if (state.entries > config.limits.maxScanEntries) {
            state.truncated = true;

            return;
        }

        if (!isScannableName(entry.name)) {
            continue;
        }

        let info;

        try {
            info = await childStat(dir, entry.name);
        } catch {
            state.skipped++;
            continue;
        }

        if (info.isSymbolicLink()) {
            state.skipped++;
            continue;
        }

        const childSegments = [...segments, entry.name];
        const childPath = childSegments.join("/");

        if (info.isDirectory()) {
            if (
                request.mode === "files" &&
                (request.query === "" ||
                    childPath.toLowerCase().includes(request.query.toLowerCase()))
            ) {
                items.push({ key: `${childPath}/`, text: fileItem(host, childPath, true, 0) });
            }

            if (depth >= config.limits.maxDepth) {
                state.depthTruncated = true;
                continue;
            }

            let child;

            try {
                child = await openChildDirectory(scope, dir, entry.name);
            } catch {
                state.skipped++;
                continue;
            }

            try {
                await scanDirectory(
                    host,
                    config,
                    scope,
                    request,
                    child,
                    childSegments,
                    depth + 1,
                    state,
                    dirs,
                    files,
                    items,
                );
            } finally {
                await child.iterator.close().catch(() => {});
                await child.handle.close().catch(() => {});
            }

            continue;
        }

        if (!info.isFile()) {
            state.skipped++;
            continue;
        }

        if (info.nlink > 1n) {
            state.skipped++;
            continue;
        }

        const fileStat = statKey(info);
        let record: SearchFile = { segments: childSegments, path: childPath, stat: fileStat };

        if (request.mode === "files") {
            files.push(record);

            if (
                request.query === "" ||
                childPath.toLowerCase().includes(request.query.toLowerCase())
            ) {
                items.push({
                    key: childPath,
                    text: fileItem(host, childPath, false, fileStat.size),
                });
            }

            continue;
        }

        // Text mode snapshots every touched regular file, including ones skipped below.
        files.push(record);

        if (fileStat.size > config.limits.maxSearchFileBytes) {
            state.skipped++;
            state.truncated = true;
            continue;
        }

        const remainingBytes = config.limits.maxScanBytes - state.bytes;

        if (remainingBytes <= 0) {
            state.truncated = true;
            continue;
        }

        const readLimit = Math.min(config.limits.maxSearchFileBytes, remainingBytes);

        if (fileStat.size > readLimit) {
            state.skipped++;
            state.truncated = true;
            continue;
        }

        let read;
        let readBytes = 0;

        try {
            read = await readChildRegular(
                scope,
                dir,
                entry.name,
                readLimit,
                scope.signal,
                (bytes) => {
                    state.bytes += bytes;
                    readBytes += bytes;
                },
            );
        } catch (error) {
            // Charge the rest of the attempted cap even when the read failed, including timeout/cancel after IO.
            state.bytes += Math.max(0, Math.min(fileStat.size, readLimit) - readBytes);

            if (
                error instanceof OpsError &&
                (error.code === "timeout" || error.code === "cancelled")
            ) {
                throw error;
            }

            state.skipped++;
            state.truncated = true;
            continue;
        }

        record = { segments: childSegments, path: childPath, stat: read.stat, hash: read.hash };
        files[files.length - 1] = record;

        if (read.buffer.includes(0)) {
            state.skipped++;
            state.truncated = true;
            continue;
        }

        let text;

        try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.buffer);
        } catch {
            state.skipped++;
            state.truncated = true;
            continue;
        }

        if (byteLength(text) !== read.buffer.length) {
            state.skipped++;
            state.truncated = true;
            continue;
        }

        let lineStart = 0;
        let lineNumber = 1;

        while (lineStart < text.length) {
            throwIfAborted(scope.signal);

            const newline = text.indexOf("\n", lineStart);
            const lineEnd = newline === -1 ? text.length : newline;
            const rawLine = text.slice(lineStart, lineEnd);
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

            if (line.includes(request.query)) {
                state.matches++;

                if (state.matches > config.limits.maxMatches) {
                    state.truncated = true;
                    state.stop = true;

                    return;
                }

                items.push({
                    key: `${childPath}\u0000${String(lineNumber).padStart(10, "0")}`,
                    text: itemLine(
                        host,
                        childPath,
                        lineNumber,
                        line,
                        config.limits.maxMatchLineBytes,
                    ),
                });
            }

            if (newline === -1) {
                break;
            }

            lineStart = newline + 1;
            lineNumber++;
        }
    }
}

interface SearchMeta {
    readonly path: string;
    readonly mode: "files" | "text";
    readonly query: string;
    readonly scanned: number;
    readonly dirCount: number;
    readonly fileCount: number;
    readonly total: number;
    readonly shown: number;
    readonly budget: number;
    readonly done: boolean;
    readonly truncated: boolean;
    readonly scanTruncated: boolean;
    readonly depthTruncated: boolean;
    readonly skipped: number;
    readonly handle?: string;
}

function renderSearch(host: OpsHost, meta: SearchMeta, body: string): string {
    const attrs: Attr[] = [
        ["path", meta.path],
        ["mode", meta.mode],
        ["query", meta.query === "" ? undefined : meta.query],
        ["scanned", meta.scanned],
        ["dirs", meta.dirCount],
        ["files", meta.fileCount],
        ["total", meta.total],
        ["shown", meta.shown],
        ["budget", meta.budget],
        ["tokens_budget_est", tokenEstimate(meta.budget)],
        ["done", meta.done],
        ["truncated", meta.truncated],
        ["scan_truncated", meta.scanTruncated],
        ["depth_truncated", meta.depthTruncated],
        ["truncated", meta.truncated],
        ["skipped", meta.skipped],
        ["handle", meta.handle],
    ];

    return envelope(host, "ops_search", attrs, body, NOTE_SEARCH);
}

function searchOverhead(host: OpsHost, meta: SearchMeta): number {
    return byteLength(
        renderSearch(host, { ...meta, done: false, truncated: true, handle: "0".repeat(48) }, ""),
    );
}

interface Composed {
    readonly body: string;
    readonly next: number;
    readonly done: boolean;
}

function composeItems(items: readonly string[], start: number, contentBudget: number): Composed {
    let body = "";
    let bytes = 0;
    let index = start;

    for (; index < items.length; index++) {
        const line = `${index + 1}|${items[index]!}`;
        const separator = body === "" ? 0 : 1;
        const length = byteLength(line);

        if (bytes + separator + length > contentBudget) {
            break;
        }

        body = body === "" ? line : `${body}\n${line}`;
        bytes += separator + length;
    }

    return { body, next: index, done: index >= items.length };
}

type SearchBase = Omit<SearchSnapshot, "next">;

interface SearchPage extends Page {
    readonly next?: number;
}

async function buildSearchPage(
    host: OpsHost,
    scope: Scope,
    store: HandleStore,
    base: SearchBase,
    items: readonly string[],
    start: number,
    budget: number,
    mode: "create" | "reuse",
    existingHandle?: string,
    created?: Set<string>,
): Promise<SearchPage> {
    const metaBase: SearchMeta = {
        path: base.path,
        mode: base.mode,
        query: base.query,
        scanned: base.scanned,
        dirCount: base.dirs.length,
        fileCount: base.files.length,
        total: items.length,
        shown: 0,
        budget,
        done: false,
        truncated: true,
        scanTruncated: base.scanTruncated,
        depthTruncated: base.depthTruncated,
        skipped: base.skipped,
    };
    const overhead = searchOverhead(host, metaBase);

    if (budget <= overhead + 16) {
        return {
            text: minimalError(host, "ops_search", "ops: page budget is too small", budget),
            done: false,
        };
    }

    const initial = Math.max(0, budget - overhead - 16);
    let low = 0;
    let high = initial;
    let best:
        { readonly composed: Composed; readonly body: string; readonly text: string } | undefined;

    for (let attempt = 0; attempt < 16 && low <= high; attempt++) {
        const mid = Math.floor((low + high) / 2);
        const candidate = composeItems(items, start, mid);

        if (!candidate.done && candidate.body.length === 0) {
            high = mid - 1;
            continue;
        }

        const body = host.text.defang(candidate.body);
        const text = renderSearch(
            host,
            {
                ...metaBase,
                shown: candidate.next - start,
                done: candidate.done,
                truncated: !candidate.done,
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
            text: minimalError(host, "ops_search", "ops: page budget is too small", budget),
            done: false,
        };
    }

    const composed = best.composed;
    const body = best.body;
    let rendered = best.text;

    if (composed.done) {
        const origin: SearchOrigin = {
            kind: "search",
            snapshot: { ...base, next: 0 },
            budget,
            complete: true,
        };

        return { text: rendered, done: true, next: composed.next, origin };
    }

    if (composed.body.length === 0) {
        return {
            text: minimalError(host, "ops_search", "ops: page budget is too small", budget),
            done: false,
        };
    }

    await verifyScope(host, scope);

    let handle = existingHandle;

    if (mode === "create") {
        const snapshot: SearchSnapshot = { ...base, next: composed.next };

        handle = store.create(snapshot, estimateSnapshotBytes(snapshot));

        if (handle !== undefined) {
            created?.add(handle);
        }

        if (handle === undefined) {
            return {
                text: minimalError(
                    host,
                    "ops_search",
                    "ops: page cache limit reached; retry later",
                    budget,
                ),
                done: false,
            };
        }
    }

    if (handle === undefined) {
        return {
            text: minimalError(host, "ops_search", "ops: page handle is unavailable", budget),
            done: false,
        };
    }

    const withHandle = renderSearch(
        host,
        {
            ...metaBase,
            shown: composed.next - start,
            done: false,
            truncated: true,
            handle,
        },
        body,
    );

    if (byteLength(withHandle) > budget) {
        if (mode === "create") {
            store.delete(handle);
        }

        return {
            text: minimalError(host, "ops_search", "ops: page budget is too small", budget),
            done: false,
        };
    }

    assertRequester(host, scope);

    const origin: SearchOrigin = {
        kind: "search",
        snapshot: { ...base, next: 0 },
        budget,
        complete: false,
    };

    return { text: withHandle, handle, done: false, next: composed.next, origin };
}

export function searchIdentity(args: SearchArgs, config: Config): SearchIdentity {
    const request = parseSearch(args);

    return { ...request, budget: effectiveBudget(args, config.limits.maxOutputBytes) };
}

export async function opsSearch(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    args: SearchArgs,
    share?: ScanShare,
    created?: Set<string>,
): Promise<Page> {
    assertRequester(host, scope);

    const request = parseSearch(args);
    const budget = effectiveBudget(args, config.limits.maxOutputBytes);
    const effectiveConfig: Config = share
        ? {
              ...config,
              limits: {
                  ...config.limits,
                  maxScanBytes: Math.max(0, config.limits.maxScanBytes - share.bytes),
                  maxScanEntries: Math.max(0, config.limits.maxScanEntries - share.entries),
              },
          }
        : config;
    const state: ScanState = {
        entries: 0,
        bytes: 0,
        matches: 0,
        skipped: 0,
        truncated: false,
        stop: false,
        depthTruncated: false,
    };
    const dirs: SearchDir[] = [];
    const files: SearchFile[] = [];
    const items: Item[] = [];
    const start = await openDirectoryForScan(scope, request.segments).catch(() =>
        fail("path", "ops: search path must be a readable directory"),
    );

    try {
        await scanDirectory(
            host,
            effectiveConfig,
            scope,
            request,
            start,
            request.segments,
            0,
            state,
            dirs,
            files,
            items,
        );
    } finally {
        // Merge the ledger even when scanDirectory threw or a close fails. A failed read after IO still consumes
        // this item's share; closing the fd is best-effort.
        if (share !== undefined) {
            share.bytes += state.bytes;
            share.entries += state.entries;
            share.truncated = share.truncated || state.truncated;
        }

        await start.iterator.close().catch(() => {});
        await start.handle.close().catch(() => {});
    }

    items.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

    const lines = items.map((item) => item.text);
    const base: SearchBase = {
        kind: "search",
        conversationId: scope.conversationId,
        requester: scope.requester,
        cwd: scope.cwd,
        root: scope.root,
        cwdStat: scope.cwdStat,
        mode: request.mode,
        path: request.path,
        segments: request.segments,
        query: request.query,
        items: lines,
        scanned: state.entries,
        dirs,
        files,
        scanTruncated: state.truncated,
        depthTruncated: state.depthTruncated,
        skipped: state.skipped,
    };

    if (lines.length === 0) {
        await verifyScope(host, scope);
        assertRequester(host, scope);
        throwIfAborted(scope.signal);

        const attrs: Attr[] = [
            ["path", request.path],
            ["mode", request.mode],
            ["query", request.query === "" ? undefined : request.query],
            ["scanned", state.entries],
            ["dirs", dirs.length],
            ["files", files.length],
            ["budget", budget],
            ["tokens_budget_est", tokenEstimate(budget)],
            ["done", true],
            ["truncated", state.truncated],
            ["scan_truncated", state.truncated],
            ["depth_truncated", state.depthTruncated],
            ["skipped", state.skipped],
            ["empty", true],
        ];
        const text = envelope(host, "ops_search", attrs, "", NOTE_SEARCH);

        return {
            text:
                byteLength(text) <= budget
                    ? text
                    : minimalError(host, "ops_search", "ops: page budget is too small", budget),
            done: true,
            origin: {
                kind: "search",
                snapshot: { ...base, next: 0 },
                budget,
                complete: true,
            },
        };
    }

    const page = await buildSearchPage(
        host,
        scope,
        store,
        base,
        lines,
        0,
        budget,
        "create",
        undefined,
        created,
    );

    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    return page;
}

export async function verifySearchSnapshot(
    host: OpsHost,
    config: Config,
    scope: Scope,
    snapshot: SearchSnapshot,
): Promise<void> {
    await verifyScope(host, scope);

    try {
        for (const dir of snapshot.dirs) {
            const current = await statDirectory(scope, dir.segments);

            if (!sameStat(dir.stat, current)) {
                fail("stale", "ops: search snapshot changed; call the original tool again");
            }
        }

        for (const file of snapshot.files) {
            // Metadata-only validation: a file that was already over the read cap may be listed by files mode.
            // Allow its recorded size so an unchanged oversize file is not falsely stale, but never read it.
            const metadataCap = Math.max(config.limits.maxFileBytes, file.stat.size);
            const current = await statRegular(scope, file.segments, metadataCap);

            if (!sameStat(file.stat, current)) {
                fail("stale", "ops: search snapshot changed; call the original tool again");
            }

            if (file.hash !== undefined) {
                const read = await readRegular(
                    scope,
                    file.segments,
                    config.limits.maxSearchFileBytes,
                    scope.signal,
                );

                if (read.hash !== file.hash) {
                    fail("stale", "ops: search snapshot changed; call the original tool again");
                }
            }
        }
    } catch (error) {
        if (error instanceof OpsError && (error.code === "timeout" || error.code === "cancelled")) {
            throw error;
        }

        if (error instanceof OpsError && error.code === "stale") {
            throw error;
        }

        fail("stale", "ops: search snapshot changed; call the original tool again");
    }
}

/** Continue a search handle after revalidating every scanned directory and file. */
export async function resumeSearch(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    entry: Entry,
    args: { readonly maxBytes?: number; readonly maxTokens?: number },
): Promise<Page> {
    const snapshot = entry.snapshot;

    if (snapshot.kind !== "search") {
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

    try {
        await verifySearchSnapshot(host, config, scope, snapshot);
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

    const base: SearchBase = {
        kind: "search",
        conversationId: snapshot.conversationId,
        requester: snapshot.requester,
        cwd: snapshot.cwd,
        root: snapshot.root,
        cwdStat: snapshot.cwdStat,
        mode: snapshot.mode,
        path: snapshot.path,
        segments: snapshot.segments,
        query: snapshot.query,
        scanned: snapshot.scanned,
        items: snapshot.items,
        dirs: snapshot.dirs,
        files: snapshot.files,
        scanTruncated: snapshot.scanTruncated,
        depthTruncated: snapshot.depthTruncated,
        skipped: snapshot.skipped,
    };
    const budget = effectiveBudget(args, config.limits.maxOutputBytes);
    const page = await buildSearchPage(
        host,
        scope,
        store,
        base,
        snapshot.items,
        snapshot.next,
        budget,
        "reuse",
        entry.handle,
    );

    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    if (page.done) {
        store.delete(entry.handle);

        return { text: page.text, done: true };
    }

    if (page.next !== undefined) {
        const next: SearchSnapshot = { ...snapshot, next: page.next };

        if (!store.update(entry.handle, next)) {
            return handleMiss();
        }

        store.touch(entry.handle);
    }

    return { text: page.text, handle: page.handle ?? entry.handle, done: false };
}
