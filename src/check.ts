/** ops_check: a bounded identity check that never returns file content. */

import type { Config, OpsHost, Page, ScanShare, Scope, StatKey } from "./types.ts";
import { effectiveBudget, tokenEstimate } from "./budget.ts";
import { fail, OpsError, throwIfAborted } from "./errors.ts";
import { readRegular, statRegular } from "./fs-safe.ts";
import { relativeSegments, sameStat } from "./paths.ts";
import { assertRequester, verifyScope } from "./scope.ts";
import { type Attr, byteLength, minimalError, shortEnvelope } from "./render.ts";

const MAX_PATH_CHARS = 4_096;

export interface CheckArgs {
    readonly path: string;
    readonly hash?: boolean;
    readonly maxBytes?: number;
    readonly maxTokens?: number;
}

export interface CheckResult {
    readonly page: Page;
    readonly stat?: StatKey;
    readonly ref?: string;
    readonly hash?: string;
    readonly changed?: boolean;
}

function statRef(stat: StatKey): string {
    return `stat:${stat.mtimeNs}-${stat.ctimeNs}-${stat.size}-${stat.ino}`;
}

function pageText(host: OpsHost, budget: number, attrs: readonly Attr[], message: string): Page {
    const text = shortEnvelope(host, "ops_check", attrs, message);

    return {
        text: byteLength(text) <= budget ? text : minimalError(host, "ops_check", message, budget),
        done: true,
    };
}

/** Check one regular file's identity. With `hash`, also read it under the file cap and return a 16-hex SHA-256 prefix. */
export async function opsCheck(
    host: OpsHost,
    config: Config,
    scope: Scope,
    args: CheckArgs,
    known?: { readonly stat: StatKey },
    share?: ScanShare,
): Promise<CheckResult> {
    assertRequester(host, scope);

    const segments = relativeSegments(args.path, MAX_PATH_CHARS);
    const path = segments.join("/");
    const budget = effectiveBudget(args, config.limits.maxOutputBytes);

    throwIfAborted(scope.signal);

    if (args.hash === true) {
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
                segments,
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
                const rest = Math.max(0, readLimit - charged);

                share.bytes += rest;

                if (rest > 0 || (error instanceof OpsError && error.code === "changed")) {
                    share.truncated = true;
                }
            }

            throw error;
        }

        const ref = `sha256:${file.hash.slice(0, 16)}`;
        const changed = known === undefined ? undefined : !sameStat(known.stat, file.stat);

        await verifyScope(host, scope);
        assertRequester(host, scope);
        throwIfAborted(scope.signal);

        return {
            stat: file.stat,
            ref,
            hash: `sha256:${file.hash}`,
            changed,
            page: pageText(
                host,
                budget,
                [
                    ["path", path],
                    ["ref", ref],
                    ["size", file.stat.size],
                    ["changed", changed],
                    ["hash", `sha256:${file.hash.slice(0, 16)}`],
                    ["budget", budget],
                    ["tokens_budget_est", tokenEstimate(budget)],
                    ["done", true],
                ],
                changed === undefined
                    ? "ops: identity only; no earlier read in this session"
                    : "ops: identity checked",
            ),
        };
    }

    if (share !== undefined) {
        if (share.entries >= config.limits.maxScanEntries) {
            share.truncated = true;
            fail("limit", "ops: batch scan entry limit reached");
        }

        share.entries += 1;
    }

    const stat = await statRegular(scope, segments, config.limits.maxFileBytes);
    const ref = statRef(stat);
    const changed = known === undefined ? undefined : !sameStat(known.stat, stat);

    await verifyScope(host, scope);
    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    return {
        stat,
        ref,
        changed,
        page: pageText(
            host,
            budget,
            [
                ["path", path],
                ["ref", ref],
                ["size", stat.size],
                ["changed", changed],
                ["budget", budget],
                ["tokens_budget_est", tokenEstimate(budget)],
                ["done", true],
            ],
            changed === undefined
                ? "ops: identity only; no earlier read in this session"
                : "ops: identity checked",
        ),
    };
}
