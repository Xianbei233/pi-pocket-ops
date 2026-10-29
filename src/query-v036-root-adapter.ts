/**
 * Draft-only 0.3.6 D root adapter. Not imported by 0.3.5/034/035 source.
 *
 * This is the integration boundary: actual codemode afterTool result + actual ALS ledger,
 * root presentation only. It never executes or replays a command.
 */

import { pageCapture, type QueryCapture, type QuerySnapshotIdentity } from "./query-v034.ts";
import {
    createRootSurfaceSnapshot,
    evaluateRootSurface,
    renderRootSurface,
    rootSurfaceBudget,
    type RootCodemodeOutput,
    type RootGroupProof,
    type RootSurfaceStore,
} from "./query-v036.ts";

export interface CodemodeLedgerEntryLike {
    readonly name: string;
    readonly status: "pending" | "ok" | "error";
    readonly queryEligible?: boolean;
    readonly returnedHandle?: boolean;
}

export interface CodemodeLedgerLike {
    readonly taskId: string;
    readonly rootCallId: string;
    readonly conversationId: number;
    readonly requester: string | undefined;
    readonly cwd: string | undefined;
    readonly cwdDev?: string;
    readonly cwdIno?: string;
    readonly configRevision?: string;
    readonly trusted: boolean;
    readonly dirty: boolean;
    readonly overflow: boolean;
    readonly closed: boolean;
    readonly entries: ReadonlyMap<string, CodemodeLedgerEntryLike>;
}

export interface RootAfterToolInput {
    readonly result: RootCodemodeOutput;
    readonly ledger: CodemodeLedgerLike;
    readonly outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number };
    readonly api: { readonly taskId: string; readonly conversationId: number };
    readonly callId: string;
    readonly identity: QuerySnapshotIdentity;
    readonly store: RootSurfaceStore;
    readonly budget: number;
    readonly frame: (
        body: string,
        meta: {
            readonly bytes: number;
            readonly handle: string;
            readonly offset: 0;
            readonly summary: true;
        },
    ) => string;
}

function proofFor(input: RootAfterToolInput): RootGroupProof | undefined {
    const ledger = input.ledger;

    if (
        ledger.taskId !== String(input.api.taskId) ||
        ledger.rootCallId !== input.callId ||
        ledger.conversationId !== input.api.conversationId ||
        ledger.requester === undefined ||
        ledger.cwd === undefined ||
        ledger.requester !== input.identity.requester ||
        ledger.cwd !== input.identity.cwd ||
        ledger.cwdDev !== input.identity.cwdDev ||
        ledger.cwdIno !== input.identity.cwdIno ||
        ledger.configRevision !== input.identity.configRevision
    ) {
        return undefined;
    }

    return {
        entries: [...ledger.entries.values()].map((entry) => ({
            name: entry.name,
            status: entry.status,
            queryEligible: entry.queryEligible === true,
            returnedHandle: entry.returnedHandle === true,
        })),
        taskId: ledger.taskId,
        rootCallId: ledger.rootCallId,
        conversationId: ledger.conversationId,
        requester: input.identity.requester,
        cwd: input.identity.cwd,
        cwdDev: input.identity.cwdDev,
        cwdIno: input.identity.cwdIno,
        configRevision: input.identity.configRevision,
        trusted: ledger.trusted,
        complete: ledger.closed,
        closed: ledger.closed,
        dirty: ledger.dirty,
        overflow: ledger.overflow,
    };
}

/** Apply a summary/full-root handle only to the root codemode result, preserving details/diagnostics. */
export interface RootSurfaceApply {
    readonly output: RootCodemodeOutput;
    readonly handle: string;
}

export function applyRootCodemodeSurface(input: RootAfterToolInput): RootSurfaceApply | undefined {
    const group = proofFor(input);

    if (group === undefined) {
        return undefined;
    }

    const surface = {
        output: input.result,
        group,
        ...(input.outputLimits === undefined ? {} : { outputLimits: input.outputLimits }),
    };
    const checked = evaluateRootSurface(surface);

    if (!checked.eligible) {
        return undefined;
    }

    const page = renderRootSurface(
        surface,
        input.identity,
        input.callId,
        input.store,
        input.budget,
        input.frame,
    );

    if (page === undefined) {
        return undefined;
    }

    return {
        output: {
            ...input.result,
            content: [{ type: "text", text: page.text }],
        },
        handle: page.handle,
    };
}

export interface RootResumeCommit {
    readonly ok: boolean;
    readonly text?: string;
    readonly handle?: string;
    readonly done?: boolean;
    readonly reason?: "miss" | "budget";
}

export interface RootResumePending {
    readonly text: string;
    readonly nextOffset?: number;
    readonly finalize: () => RootResumeCommit;
    readonly discard: () => void;
}

export type RootResumePreparation =
    | { readonly kind: "page"; readonly page: RootResumePending }
    | { readonly kind: "budget"; readonly handle: string }
    | { readonly kind: "miss" };

function rootLineCount(text: string): number {
    return text === "" ? 0 : (text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

/** Prepare one root-surface resume. No cursor commit occurs until outer final verification. */
export function prepareRootResume(
    handle: string,
    identity: QuerySnapshotIdentity,
    store: RootSurfaceStore,
    budget: number,
    frame: (
        body: string,
        meta: {
            readonly bytes: number;
            readonly handle?: string;
            readonly next?: number;
            readonly offset?: number;
            readonly done: boolean;
        },
    ) => string,
): RootResumePreparation {
    const lease = store.claim(handle, identity);

    if (lease === undefined) {
        return { kind: "miss" };
    }

    const snapshot = lease.snapshot;
    const capture: QueryCapture = {
        text: snapshot.text,
        bytes: Buffer.byteLength(snapshot.text, "utf8"),
        lines: rootLineCount(snapshot.text),
        skippedBytes: 0,
        skippedLines: 0,
        complete: true,
        nestedSafe: true,
    };
    const fake = "0".repeat(48);
    const contentCap = Math.min(budget, 50 * 1024);
    let allowed = contentCap;

    try {
        const empty = frame("", {
            bytes: capture.bytes,
            handle: fake,
            next: snapshot.offset,
            offset: snapshot.offset,
            done: false,
        });
        const overheadBytes = Buffer.byteLength(empty, "utf8") + 32;
        const overheadLines = rootLineCount(empty);

        for (let attempt = 0; attempt < 4; attempt++) {
            if (allowed < 256) {
                store.release(lease);

                return { kind: "budget", handle };
            }

            const page = pageCapture(capture, {
                budget: allowed,
                overheadBytes,
                overheadLines,
                maxBytes: 50 * 1024,
                maxLines: 2_000,
                handle: fake,
                offset: snapshot.offset,
            });

            if (page.error !== undefined) {
                store.release(lease);

                return { kind: "budget", handle };
            }

            if (page.done) {
                const text = frame(page.text, {
                    bytes: capture.bytes,
                    offset: snapshot.offset,
                    done: true,
                });
                const finalLines = rootLineCount(text);

                if (Buffer.byteLength(text, "utf8") <= contentCap && finalLines <= 2_000) {
                    return {
                        kind: "page",
                        page: {
                            text,
                            finalize: () => {
                                if (!store.commitDone(lease)) {
                                    store.release(lease);

                                    return { ok: false, reason: "miss" };
                                }

                                return { ok: true, text, done: true };
                            },
                            discard: () => {
                                store.deleteScope(identity);
                                store.release(lease);
                            },
                        },
                    };
                }

                allowed -= Math.max(16, Buffer.byteLength(text, "utf8") - contentCap + 8);
                continue;
            }

            if (page.nextOffset === undefined) {
                store.release(lease);

                return { kind: "budget", handle };
            }

            const text = frame(page.text, {
                bytes: capture.bytes,
                handle,
                next: page.nextOffset,
                offset: snapshot.offset,
                done: false,
            });
            const finalLines = rootLineCount(text);

            if (
                Buffer.byteLength(text, "utf8") > Math.min(budget, 50 * 1024) ||
                finalLines > 2_000
            ) {
                allowed -= Math.max(16, Buffer.byteLength(text, "utf8") - contentCap + 8);
                continue;
            }

            // The exact delivered text is frozen now; finalize only commits the cursor.
            const nextOffset = page.nextOffset;

            return {
                kind: "page",
                page: {
                    text,
                    nextOffset,
                    finalize: () => {
                        if (!store.advance(lease, nextOffset)) {
                            store.deleteScope(identity);
                            store.release(lease);

                            return { ok: false, reason: "miss" };
                        }

                        store.release(lease);

                        return {
                            ok: true,
                            text,
                            handle,
                            done: false,
                        };
                    },
                    discard: () => {
                        store.deleteScope(identity);
                        store.release(lease);
                    },
                },
            };
        }

        store.release(lease);

        return { kind: "budget", handle };
    } catch {
        // Rendering/observer failure: release the busy lease, but do not consume or revoke
        // the owner's historical handle.
        store.release(lease);

        return { kind: "miss" };
    }
}

export const rootBudget = rootSurfaceBudget;
export type { RootCodemodeOutput, RootGroupProof, RootSurfaceStore };
export { createRootSurfaceSnapshot, renderRootSurface };
