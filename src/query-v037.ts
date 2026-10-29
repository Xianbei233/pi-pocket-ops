/** Draft-only 0.3.7 D2: actual nested-output eligibility classification. */

export interface QuerySurfaceObservation {
    readonly complete: boolean;
    readonly bytes: number;
    readonly nestedSafe: boolean;
}

export interface NestedOutputLike {
    readonly content?: readonly {
        readonly type: string;
        readonly text?: string;
    }[];
    readonly isError?: boolean;
}

const READ_QUERY = new Set(["read", "ops_read", "ops_search", "ops_check"]);
const OPS_NAMES = new Set(["ops_read", "ops_search", "ops_check"]);
const CONTROL = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/u;
const KNOWN_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
    ops_read: new Set([
        "path",
        "ref",
        "bytes",
        "hash",
        "line",
        "window_end",
        "budget",
        "tokens_budget_est",
        "done",
        "truncated",
        "handle",
        "next_offset",
        "next_kind",
    ]),
    ops_search: new Set([
        "path",
        "mode",
        "query",
        "scanned",
        "dirs",
        "files",
        "total",
        "shown",
        "budget",
        "tokens_budget_est",
        "done",
        "truncated",
        "scan_truncated",
        "depth_truncated",
        "skipped",
        "handle",
        "empty",
        "next_offset",
        "next_kind",
    ]),
    ops_check: new Set([
        "path",
        "ref",
        "size",
        "changed",
        "hash",
        "budget",
        "tokens_budget_est",
        "done",
    ]),
};
const ATTR = /([A-Za-z_][A-Za-z0-9_]*)=(?:“([^”]*)”|"([^"]*)"|([^\s]+))/gu;
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
    ops_read: ["path", "bytes", "hash", "done"],
    ops_search: ["path", "mode", "done"],
    ops_check: ["path", "ref", "size", "done"],
};

function attrsValid(attrs: string, name: string): boolean {
    const allowed = KNOWN_ATTRS[name];

    if (allowed === undefined) {
        return false;
    }

    const seen = new Map<string, string>();
    const counts = new Map<string, number>();
    let cursor = 0;
    let match: RegExpExecArray | null;

    ATTR.lastIndex = 0;

    while ((match = ATTR.exec(attrs)) !== null) {
        if (attrs.slice(cursor, match.index).trim() !== "") {
            return false;
        }

        const key = match[1]!;
        const value = match[2] ?? match[3] ?? match[4] ?? "";

        if (!allowed.has(key)) {
            return false;
        }

        if (seen.has(key)) {
            // The loaded old search renderer has exactly two literal `truncated` attrs.
            const count = counts.get(key) ?? 0;

            if (
                name !== "ops_search" ||
                key !== "truncated" ||
                seen.get(key) !== value ||
                count >= 2
            ) {
                return false;
            }

            counts.set(key, count + 1);
        } else {
            seen.set(key, value);
            counts.set(key, 1);
        }

        cursor = match.index + match[0].length;
    }

    if (attrs.slice(cursor).trim() !== "") {
        return false;
    }

    return REQUIRED[name]!.every((key) => seen.has(key));
}

function opsSuccess(text: string, name: string): boolean {
    if (name === "read") {
        return text !== "" && !CONTROL.test(text) && !/^<ops_/u.test(text);
    }

    if (!OPS_NAMES.has(name)) {
        return false;
    }

    const tag = name;

    if (!text.startsWith(`<${tag}`)) {
        return false;
    }

    const match = new RegExp(`^<${tag}\\b([^>]*)>([\\s\\S]*)<\\/${tag}>\\s*$`, "u").exec(text);

    if (match === null || CONTROL.test(text)) {
        return false;
    }

    return attrsValid(match[1] ?? "", name);
}

function plainText(result: NestedOutputLike): string | undefined {
    const parts = result.content ?? [];

    if (
        parts.length === 0 ||
        parts.some((part) => part.type !== "text" || typeof part.text !== "string")
    ) {
        return undefined;
    }

    return parts.map((part) => part.text ?? "").join("\n");
}

/**
 * Only actual completed output may make an entry D2-eligible. `batch`/`ops_result` are
 * conservative: success plain text with no already-paged handle only.
 */
export function nestedQueryEligible(
    name: string,
    status: "pending" | "ok" | "error",
    result: NestedOutputLike,
    observation?: QuerySurfaceObservation,
): boolean {
    if (status !== "ok" || result.isError === true) {
        return false;
    }

    if (name === "bash") {
        return observation !== undefined && observation.complete && observation.nestedSafe;
    }

    const text = plainText(result);

    if (text === undefined) {
        return false;
    }

    if (READ_QUERY.has(name)) {
        return opsSuccess(text, name);
    }

    // Batch/result have insufficient stable success evidence here; keep native.
    return false;
}
