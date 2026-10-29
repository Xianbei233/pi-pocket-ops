/** Path and text validation: relative paths only, and a conservative deny list that explicit reads cannot bypass. */

import { sep } from "node:path";
import type { StatKey } from "./types.ts";
import { fail } from "./errors.ts";

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const MAX_SEGMENT_BYTES = 255;

const EXCLUDED_NAMES = new Set([
    "node_modules",
    "raw",
    "original",
    "uploads",
    "attachments",
    "secrets",
    "secret",
    "credentials",
    "credential",
    "auth",
    "auth.json",
    "auth.yml",
    "auth.yaml",
    "token.json",
    "tokens.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "known_hosts",
    "shadow",
    "原文",
]);

const EXCLUDED_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/iu;

/** True when child is parent or lies below it. Both paths are absolute and normalized. */
export function isInside(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** Reject characters and names that are ambiguous in a path or in a header. */
export function hasUnsafeChars(value: string): boolean {
    return UNSAFE.test(value) || value.isWellFormed() === false;
}

/** True for a name the policy never scans, lists, or opens. */
export function isExcludedName(name: string): boolean {
    if (name.startsWith(".") || name === "" || name === "." || name === "..") {
        return true;
    }

    const lower = name.toLowerCase();

    if (EXCLUDED_NAMES.has(lower)) {
        return true;
    }

    if (lower.startsWith("secret") || lower.startsWith("credential")) {
        return true;
    }

    return EXCLUDED_EXTENSIONS.test(name);
}

/**
 * Parse a model-supplied relative path. It must stay below the scope cwd: no absolute path, drive, UNC, `..`, empty
 * segment, backslash, control character, bidirectional character, hidden component, or excluded name.
 */
export function relativeSegments(raw: unknown, maxChars: number): string[] {
    if (typeof raw !== "string") {
        fail("path", "ops: invalid path: must be a string relative to the session folder");
    }

    if (raw.length === 0 || raw.length > maxChars) {
        fail("path", "ops: invalid path: empty or too long");
    }

    if (raw !== raw.trim()) {
        fail("path", "ops: invalid path: leading or trailing whitespace");
    }

    if (hasUnsafeChars(raw)) {
        fail("path", "ops: invalid path: control, invisible, or direction character");
    }

    if (
        raw.includes("\\") ||
        raw.startsWith("~") ||
        raw.startsWith("/") ||
        /^[A-Za-z]:/u.test(raw)
    ) {
        fail("path", "ops: invalid path: must be relative to the session folder");
    }

    const segments = raw.split("/");

    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail("path", "ops: invalid path: empty, current, or parent segment");
    }

    for (const segment of segments) {
        if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) {
            fail("path", "ops: invalid path: a segment is too long");
        }

        if (segment.endsWith(" ") || segment.endsWith(".")) {
            fail("path", "ops: invalid path: a segment ends with a space or dot");
        }

        if (isExcludedName(segment)) {
            fail("path", "ops: path denied by the read-only policy");
        }
    }

    return segments;
}

/** Parse a literal search query. No regex is ever built from it. */
export function literalQuery(raw: unknown, maxChars: number): string {
    if (typeof raw !== "string" || raw.length === 0) {
        fail("query", "ops: invalid query: must be a non-empty literal string");
    }

    if (raw.length > maxChars) {
        fail("query", "ops: invalid query: too long");
    }

    if (hasUnsafeChars(raw) || raw.includes("\n") || raw.includes("\r")) {
        fail("query", "ops: invalid query: control, invisible, direction, or line-break character");
    }

    return raw;
}

/** Convert BigInt stats to a comparable key. */
export function statKey(stats: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly mode: bigint;
    readonly nlink: bigint;
}): StatKey {
    return {
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
        size: Number(stats.size),
        mtimeNs: stats.mtimeNs.toString(),
        ctimeNs: stats.ctimeNs.toString(),
        mode: Number(stats.mode),
        nlink: Number(stats.nlink),
    };
}

/** Compare the identity fields that matter for a stale check. */
export function sameStat(left: StatKey, right: StatKey): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.mode === right.mode &&
        left.nlink === right.nlink
    );
}

/** A directory entry name that is safe to include in a scan. */
export function isScannableName(name: string): boolean {
    return (
        !isExcludedName(name) &&
        !hasUnsafeChars(name) &&
        !name.includes("\\") &&
        !name.includes("/")
    );
}
