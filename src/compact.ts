/** Compact, stable-order rendering for batch items and session-dedup hits. */

import type { OpsHost, Page } from "./types.ts";
import { byteLength, minimalError, NOTE_BATCH, quoted, utf8Prefix } from "./render.ts";

const ATTR = /\s([a-z_]+)="([^"]*)"/gu;
const BODY = /<ops_data>\n([\s\S]*?)\n<\/ops_data>/u;
const OPEN = /^<([a-z_]+)((?:\s+[a-z_]+="[^"]*")*)>/u;

export interface Parts {
    readonly tag: string;
    readonly attrs: ReadonlyMap<string, string>;
    readonly body: string;
}

/** Split one of this module's own envelopes. The input is trusted output, not a file or a model string. */
export function parts(text: string): Parts | undefined {
    const open = OPEN.exec(text);

    if (open === null) {
        return undefined;
    }

    const attrs = new Map<string, string>();

    for (const match of open[2]!.matchAll(ATTR)) {
        attrs.set(match[1]!, match[2]!);
    }

    return { tag: open[1]!, attrs, body: BODY.exec(text)?.[1] ?? "" };
}

function attrsOf(wanted: readonly string[], found: ReadonlyMap<string, string>): string {
    const parts: string[] = [];

    for (const name of wanted) {
        const value = found.get(name);

        if (value !== undefined && value !== "") {
            parts.push(`${name}="${value}"`);
        }
    }

    return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

const READ_ATTRS = [
    "path",
    "ref",
    "line",
    "window_end",
    "truncated",
    "handle",
    "next_offset",
    "reuse",
    "dedup",
] as const;
const SEARCH_ATTRS = [
    "path",
    "mode",
    "query",
    "total",
    "shown",
    "scanned",
    "truncated",
    "handle",
    "reuse",
    "dedup",
] as const;
const CHECK_ATTRS = [
    "path",
    "ref",
    "size",
    "changed",
    "hash",
    "cached",
    "truncated",
    "handle",
] as const;

export function itemAttrs(tool: string, found: ReadonlyMap<string, string>): string {
    return attrsOf(
        tool === "ops_read"
            ? READ_ATTRS
            : tool === "ops_search"
              ? SEARCH_ATTRS
              : tool === "ops_check"
                ? CHECK_ATTRS
                : [],
        found,
    );
}

/** One compact item: a fixed-order header line, then the already-defanged body. */
export function compactItem(index: number, tool: string, page: Page): string {
    const parsed = parts(page.text);

    if (parsed === undefined || parsed.tag !== tool) {
        return `[${index}] ${tool}${itemAttrs(tool, new Map())}\n${page.text}`;
    }

    const header = `[${index}] ${tool}${itemAttrs(tool, parsed.attrs)}`;

    return parsed.body === "" ? header : `${header}\n${parsed.body}`;
}

export function errorItem(
    index: number,
    host: OpsHost,
    tool: string,
    code: string,
    message: string,
): string {
    return `[${index}] ${tool} status="error" code=${quoted(host, code, 40)} msg=${quoted(host, message, 240)}`;
}

export function omittedItem(index: number, tool: string, recoverable: boolean): string {
    return recoverable
        ? `[${index}] ${tool} status="omitted" code="output" recover="handle"`
        : `[${index}] ${tool} status="omitted" code="output" recover="retry"`;
}

/** A compact hit for a repeated standalone read. `undefined` means the hit cannot fit; read again instead. */
export function readReuseHit(
    host: OpsHost,
    path: string,
    ref: string,
    handle: string,
    line: number,
    end: number,
    budget: number,
): string | undefined {
    const text =
        `<ops_read dedup="hit" path=${quoted(host, path, 240)} ref=${quoted(host, ref, 64)} ` +
        `line="${line}" window_end="${end}" handle="${handle}" reuse="1">\n` +
        "Repeated request: the same file identity and window were already returned in this session. " +
        "Content omitted to avoid repeating text. Call ops_result with this handle for the full page, or pass fresh=true to read again.\n" +
        "</ops_read>";

    return byteLength(text) <= budget ? text : undefined;
}

/** A compact hit for a repeated standalone search. */
export function searchReuseHit(
    host: OpsHost,
    path: string,
    mode: string,
    query: string,
    total: number,
    handle: string,
    budget: number,
): string | undefined {
    const queryAttr = query === "" ? "" : ` query=${quoted(host, query, 512)}`;
    const text =
        `<ops_search dedup="hit" path=${quoted(host, path, 240)} mode="${mode}"${queryAttr} ` +
        `total="${total}" handle="${handle}" reuse="1">\n` +
        "Repeated request: the same search identity and unchanged inputs were already returned in this session. " +
        "Content omitted to avoid repeating text. Call ops_result with this handle for the full page, or pass fresh=true to search again.\n" +
        "</ops_search>";

    return byteLength(text) <= budget ? text : undefined;
}

export interface BatchHeader {
    readonly total: number;
    readonly ok: number;
    readonly errors: number;
    readonly reused: number;
    readonly fresh: number;
    readonly budget: number;
    readonly concurrency: number;
    readonly scanTruncated: boolean;
    readonly timedOut: boolean;
}

export function batchHead(header: BatchHeader): string {
    return (
        `<ops_batch v="2" ops="${header.total}" ok="${header.ok}" err="${header.errors}" ` +
        `reuse="${header.reused}" fresh="${header.fresh}" budget="${header.budget}" ` +
        `concurrency="${header.concurrency}" scan_truncated="${header.scanTruncated}" ` +
        `timed_out="${header.timedOut}">\n${NOTE_BATCH}\n<ops_data>\n`
    );
}

export const BATCH_TAIL = "\n</ops_data>\n</ops_batch>";

export function batchOverhead(header: BatchHeader): number {
    return byteLength(batchHead(header)) + byteLength(BATCH_TAIL);
}

/** Fit one item into the remaining bytes, marking any cut as recoverable. */
export function fitItem(
    index: number,
    item: string,
    remaining: number,
    host: OpsHost,
    tool: string,
    handle: string | undefined,
): string {
    if (byteLength(item) <= remaining) {
        return item;
    }

    const marker =
        handle === undefined
            ? `\n... truncated by the batch output budget; retry this item alone`
            : `\n... truncated by the batch output budget; use handle="${handle}" with ops_result`;

    if (remaining <= byteLength(marker) + 16) {
        return omittedItem(index, tool, handle !== undefined);
    }

    return `${utf8Prefix(item, remaining - byteLength(marker))}${marker}`;
}

/** The one error page a batch returns when no item could be rendered at all. */
export function batchTooSmall(host: OpsHost, budget: number): string {
    return minimalError(host, "ops_batch", "ops: batch budget is too small", budget);
}
