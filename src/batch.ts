/**
 * ops_batch: bounded read/search/check calls with one output budget, per-item timeouts, and optional concurrency.
 * Errors are isolated; caller cancellation and module disposal still propagate.
 */

import type { Config, OpsContext, OpsHost, Page, ScanShare, Scope } from "./types.ts";
import { effectiveBudget } from "./budget.ts";
import { fail, isTimeoutAbort, OpsError, safeErrorMessage, throwIfAborted } from "./errors.ts";
import type { HandleStore } from "./handles.ts";
import { type CheckResult, opsCheck } from "./check.ts";
import { opsRead, type ReadArgs } from "./read.ts";
import { opsSearch, type SearchArgs } from "./search.ts";
import { assertRequester, createCallControl, verifyScope } from "./scope.ts";
import { relativeSegments } from "./paths.ts";
import {
    BATCH_TAIL,
    batchHead,
    batchOverhead,
    batchTooSmall,
    compactItem,
    errorItem,
    fitItem,
    omittedItem,
    type BatchHeader,
} from "./compact.ts";
import type { OpsApi, SessionLayer } from "./layer.ts";

export type BatchOperation =
    | ({ readonly tool: "ops_read" } & ReadArgs & { readonly dependsOn?: number })
    | ({ readonly tool: "ops_search" } & SearchArgs & { readonly dependsOn?: number })
    | ({
          readonly tool: "ops_check";
          readonly path: string;
          readonly hash?: boolean;
          readonly maxBytes?: number;
          readonly maxTokens?: number;
          readonly dependsOn?: number;
      } & { readonly fresh?: never });

export interface BatchArgs {
    readonly operations: readonly BatchOperation[];
    readonly concurrency?: number;
    readonly itemTimeoutMs?: number;
    readonly maxBytes?: number;
    readonly maxTokens?: number;
}

interface ItemResult {
    readonly index: number;
    readonly tool: string;
    readonly ok: boolean;
    readonly reused: boolean;
    readonly fresh: boolean;
    readonly page?: Page;
    readonly text: string;
    readonly handle?: string;
    readonly omitted: boolean;
}

const ITEM_HEADER = 96;
const MIN_ITEM_BUDGET = 256;

function errorCode(error: unknown): string {
    return error instanceof OpsError ? error.code : "error";
}

function itemFailure(
    index: number,
    tool: string,
    host: OpsHost,
    code: string,
    message: string,
): ItemResult {
    return {
        index,
        tool,
        ok: false,
        reused: false,
        fresh: false,
        text: errorItem(index + 1, host, tool, code, message),
        omitted: false,
    };
}

function omittedResult(index: number, tool: string, handle?: string): ItemResult {
    return {
        index,
        tool,
        ok: false,
        reused: false,
        fresh: false,
        text: omittedItem(index + 1, tool, handle !== undefined),
        omitted: true,
    };
}

/** Validate one operation's budget against its share of the batch budget. */
function itemBudget(operation: BatchOperation, share: number): number {
    let budget = share;

    if (operation.maxBytes !== undefined) {
        budget = Math.min(budget, operation.maxBytes);
    }

    if (operation.maxTokens !== undefined) {
        budget = Math.min(budget, operation.maxTokens * 4);
    }

    return budget;
}

function checkPath(path: string): string {
    return relativeSegments(path, 4_096).join("/");
}

/** Run one operation under its own cancellation and timeout control. */
async function runOne(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    layer: SessionLayer,
    api: OpsApi,
    context: OpsContext,
    index: number,
    operation: BatchOperation,
    budget: number,
    share: ScanShare,
    created: Set<string>,
    timeoutMs: number,
): Promise<ItemResult> {
    const tool = operation.tool;
    const itemCreated = new Set<string>();
    const control = createCallControl(store, { abortSignal: scope.signal }, undefined, timeoutMs);
    const itemScope: Scope = { ...scope, signal: control.signal };

    try {
        const args = {
            ...operation,
            maxBytes: budget,
        } as BatchOperation;

        let page: Page;

        if (tool === "ops_read") {
            page = await layer.read(
                args as ReadArgs,
                itemScope,
                api,
                context,
                () => opsRead(host, config, store, itemScope, args as ReadArgs, share, itemCreated),
                itemCreated,
            );
        } else if (tool === "ops_search") {
            page = await layer.search(
                args as SearchArgs,
                itemScope,
                api,
                context,
                () =>
                    opsSearch(
                        host,
                        config,
                        store,
                        itemScope,
                        args as SearchArgs,
                        share,
                        itemCreated,
                    ),
                itemCreated,
                false,
            );
        } else if (tool === "ops_check") {
            const normalized = checkPath(operation.path);
            const known = layer.known(scope.conversationId, normalized);
            const result: CheckResult = await opsCheck(
                host,
                config,
                itemScope,
                {
                    path: operation.path,
                    hash: operation.hash,
                    maxBytes: budget,
                },
                known,
                share,
            );

            layer.noteCheck(scope.conversationId);
            page = result.page;
        } else {
            return itemFailure(index, "unknown", host, "batch", "ops: unsupported batch item");
        }

        // Confirm the item's own requester and folder before its handles/cache are allowed to outlive the item.
        await verifyScope(host, itemScope);
        throwIfAborted(itemScope.signal);

        for (const handle of itemCreated) {
            created.add(handle);
        }

        return {
            index,
            tool,
            ok: true,
            reused: page.reused === true,
            fresh: "fresh" in operation && operation.fresh === true,
            page,
            text: compactItem(index + 1, tool, page),
            handle: page.handle,
            omitted: false,
        };
    } catch (error) {
        for (const handle of itemCreated) {
            store.delete(handle);
        }

        if (
            error instanceof OpsError &&
            (error.code === "cancelled" || error.code === "disposed")
        ) {
            throw error;
        }

        if (isTimeoutAbort(control.signal) || isTimeoutAbort(scope.signal)) {
            return itemFailure(
                index,
                tool,
                host,
                "timeout",
                "ops: item timed out; narrow this item or raise the owner's limit",
            );
        }

        layer.noteError(scope.conversationId);

        return itemFailure(index, tool, host, errorCode(error), safeErrorMessage(error));
    } finally {
        control.cleanup();
    }
}

/** Run a batch. A safe item failure is contained; caller cancellation is not. */
export async function opsBatch(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    args: BatchArgs,
    layer: SessionLayer,
    api: OpsApi,
    context: OpsContext,
    created: Set<string>,
): Promise<Page> {
    assertRequester(host, scope);

    const foreignReader = !layer.allowsReplay(await api.agent(context), scope.conversationId);

    if (foreignReader) {
        layer.standDown(scope);
    }

    const operations = args.operations;

    if (!Array.isArray(operations) || operations.length === 0) {
        fail("batch", "ops: operations must contain at least one read, search, or check");
    }

    if (operations.length > config.limits.maxBatchOps) {
        fail("batch", `ops: operations must contain at most ${config.limits.maxBatchOps} items`);
    }

    if (foreignReader && operations.some((operation) => operation.tool !== "ops_check")) {
        fail(
            "compat",
            "ops_batch refused: incompatible with an active foreign reader/result wrapper or ToolTask afterTool hook. " +
                "Use the original wrapped read/ops_read/ops_search directly. ops_check-only batches remain available.",
        );
    }

    const budget = effectiveBudget(args, config.limits.maxBatchOutputBytes);
    let concurrency = args.concurrency ?? config.limits.batchConcurrency;

    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        fail("batch", "ops: concurrency must be a positive integer");
    }

    concurrency = Math.min(concurrency, config.limits.batchConcurrency);
    // A slot needs at least one scan byte and one entry. Tighten the effective concurrency instead of giving every
    // slot a minimum 1 and exceeding the shared cap.
    concurrency = Math.max(
        1,
        Math.min(
            concurrency,
            operations.length,
            config.limits.maxScanBytes,
            config.limits.maxScanEntries,
        ),
    );

    let itemTimeoutMs = args.itemTimeoutMs ?? config.limits.batchItemTimeoutMs;

    if (!Number.isSafeInteger(itemTimeoutMs) || itemTimeoutMs < 100) {
        fail("batch", "ops: itemTimeoutMs must be an integer of at least 100");
    }

    itemTimeoutMs = Math.min(itemTimeoutMs, config.limits.batchItemTimeoutMs);

    const header: BatchHeader = {
        total: operations.length,
        ok: 0,
        errors: 0,
        reused: 0,
        fresh: 0,
        budget,
        concurrency,
        scanTruncated: false,
        timedOut: false,
    };
    const overhead = batchOverhead(header) + operations.length * ITEM_HEADER;

    if (budget <= overhead + operations.length * MIN_ITEM_BUDGET) {
        return {
            text: batchTooSmall(host, budget),
            done: true,
        };
    }

    const perItem = Math.max(
        MIN_ITEM_BUDGET,
        Math.floor((budget - overhead) / operations.length) - ITEM_HEADER,
    );
    const split = (total: number): number[] =>
        Array.from(
            { length: concurrency },
            (_unused, index) =>
                Math.floor(total / concurrency) + (index < total % concurrency ? 1 : 0),
        );
    const slotBytes = split(config.limits.maxScanBytes);
    const slotEntries = split(config.limits.maxScanEntries);
    const slotConfigs: Config[] = Array.from({ length: concurrency }, (_unused, slot) => ({
        ...config,
        limits: {
            ...config.limits,
            maxScanBytes: slotBytes[slot]!,
            maxScanEntries: slotEntries[slot]!,
        },
    }));
    const shares: ScanShare[] = Array.from({ length: concurrency }, () => ({
        bytes: 0,
        entries: 0,
        truncated: false,
    }));
    const results: (ItemResult | undefined)[] = Array.from({ length: operations.length });
    // One gate per operation, used by dependsOn. A dependency may only name an earlier item.
    const settled: Promise<void>[] = [];
    const open: (() => void)[] = [];

    for (let index = 0; index < operations.length; index++) {
        settled.push(
            new Promise<void>((resolve) => {
                open.push(resolve);
            }),
        );
    }

    const release = () => {
        for (const openOne of open) {
            openOne();
        }
    };

    const onAbort = () => release();

    scope.signal?.addEventListener("abort", onAbort, { once: true });

    const queue = operations.map((_operation, index) => index);
    let next = 0;

    const worker = async (slot: number): Promise<void> => {
        for (;;) {
            if (scope.signal?.aborted === true) {
                return;
            }

            const at = next++;

            if (at >= queue.length) {
                return;
            }

            const index = queue[at]!;
            const operation = operations[index]!;
            const dependsOn = "dependsOn" in operation ? operation.dependsOn : undefined;

            try {
                if (dependsOn !== undefined) {
                    if (!Number.isSafeInteger(dependsOn) || dependsOn < 1 || dependsOn > index) {
                        results[index] = itemFailure(
                            index,
                            operation.tool,
                            host,
                            "batch",
                            "ops: dependsOn must name an earlier operation",
                        );

                        continue;
                    }

                    await settled[dependsOn - 1];
                }

                throwIfAborted(scope.signal);

                if (results[index] !== undefined) {
                    continue;
                }

                const budgetForItem = itemBudget(operation, perItem);

                if (budgetForItem < MIN_ITEM_BUDGET) {
                    results[index] = itemFailure(
                        index,
                        operation.tool,
                        host,
                        "budget",
                        "ops: batch item budget is too small",
                    );

                    continue;
                }

                const result = await runOne(
                    host,
                    slotConfigs[slot]!,
                    store,
                    scope,
                    layer,
                    api,
                    context,
                    index,
                    operation,
                    budgetForItem,
                    shares[slot]!,
                    created,
                    itemTimeoutMs,
                );

                results[index] = result;
            } catch (error) {
                if (
                    error instanceof OpsError &&
                    (error.code === "cancelled" || error.code === "disposed")
                ) {
                    throw error;
                }

                results[index] = itemFailure(
                    index,
                    operation.tool,
                    host,
                    errorCode(error),
                    safeErrorMessage(error),
                );
            } finally {
                open[index]?.();
            }
        }
    };

    let rejected: unknown;

    try {
        // Drain every worker. A fail-fast rejection could leave siblings running while withScope rolls back.
        const settled = await Promise.allSettled(
            Array.from({ length: concurrency }, (_unused, slot) => worker(slot)),
        );
        const failed = settled.find(
            (each): each is PromiseRejectedResult => each.status === "rejected",
        );

        if (failed !== undefined) {
            rejected = failed.reason;
        }
    } finally {
        scope.signal?.removeEventListener("abort", onAbort);
    }

    if (rejected !== undefined) {
        throw rejected;
    }

    if (scope.signal?.aborted === true && !isTimeoutAbort(scope.signal)) {
        throwIfAborted(scope.signal);
    }

    const timedOut = isTimeoutAbort(scope.signal);
    const finalResults: ItemResult[] = [];

    for (let index = 0; index < operations.length; index++) {
        const operation = operations[index]!;
        const result = results[index];

        if (result === undefined) {
            finalResults.push(
                timedOut
                    ? itemFailure(
                          index,
                          operation.tool,
                          host,
                          "timeout",
                          "ops: batch timed out before this item started",
                      )
                    : omittedResult(index, operation.tool),
            );
        } else {
            finalResults.push(result);
        }
    }

    if (scope.signal?.aborted === true && !timedOut) {
        throwIfAborted(scope.signal);
    }

    const ok = finalResults.filter((result) => result.ok).length;
    const errors = finalResults.filter((result) => !result.ok).length;
    const reused = finalResults.filter((result) => result.reused).length;
    const fresh = finalResults.filter((result) => result.fresh).length;
    const scanTruncated = shares.some((share) => share.truncated);
    const finalHeader: BatchHeader = {
        ...header,
        ok,
        errors,
        reused,
        fresh,
        scanTruncated,
        timedOut,
    };

    const body = finalResults.map((result) => result.text).join("\n");
    let text = `${batchHead(finalHeader)}${body}${BATCH_TAIL}`;

    // Fit each item in order, so one oversized body cannot starve the rest.
    const head = batchHead(finalHeader);
    let remaining =
        budget - Buffer.byteLength(head, "utf8") - Buffer.byteLength(BATCH_TAIL, "utf8");
    const fitted: string[] = [];

    for (const result of finalResults) {
        if (remaining <= 0) {
            fitted.push(omittedItem(result.index + 1, result.tool, result.handle !== undefined));
            continue;
        }

        const item = fitItem(
            result.index + 1,
            result.text,
            remaining,
            host,
            result.tool,
            result.handle,
        );

        if (item.startsWith(`[${result.index + 1}] ${result.tool} status="omitted"`)) {
            if (result.handle !== undefined) {
                store.delete(result.handle);
                created.delete(result.handle);
            }
        }

        fitted.push(item);
        remaining -= Buffer.byteLength(item, "utf8") + 1;
    }

    text = `${head}${fitted.join("\n")}${BATCH_TAIL}`;

    if (Buffer.byteLength(text, "utf8") > budget) {
        return {
            text: batchTooSmall(host, budget),
            done: true,
            acceptAborted: timedOut,
        };
    }

    assertRequester(host, scope);

    return {
        text,
        done: true,
        acceptAborted: timedOut,
    };
}
