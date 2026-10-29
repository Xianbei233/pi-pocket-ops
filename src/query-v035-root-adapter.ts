/**
 * 0.3.5 root adapter: B store/frame contract with the C integration type.
 *
 * The root owns the tool wrapper, runtime/config state, canonical identity, and frame. This module
 * supplies the stable integration object and renderer contract; it never executes a command.
 */

import {
    MemoryQuerySnapshots,
    createOutputSnapshot,
    pageCapture,
    type QueryCapture,
    type QuerySnapshotIdentity,
    type QuerySnapshotStore,
} from "./query-v034.ts";
import { type QueryBashIntegration } from "./query-v035-integration.ts";

export interface QueryFrameMeta {
    readonly bytes: number;
    readonly handle?: string;
    readonly next?: number;
    readonly done: boolean;
}

export type QueryFrame = (body: string, meta: QueryFrameMeta) => string;

export interface QueryRootAdapterOptions {
    readonly enabled: () => boolean;
    readonly budget: () => number;
    readonly store: QuerySnapshotStore;
    readonly identity: QueryBashIntegration["identity"];
    readonly eligible: QueryBashIntegration["eligible"];
    readonly trust: QueryBashIntegration["trust"];
    readonly finalCheck: QueryBashIntegration["finalCheck"];
    readonly noteUncovered: QueryBashIntegration["noteUncovered"];
    readonly frame: QueryFrame;
    readonly maxBytes?: number;
    readonly maxLines?: number;
}

function lineCount(text: string): number {
    return text === "" ? 0 : (text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

function queryRender(
    options: QueryRootAdapterOptions,
    capture: QueryCapture,
    identity: QuerySnapshotIdentity,
    store: QuerySnapshotStore,
    sourceCallId: string,
): { readonly text: string } | undefined {
    const budget = options.budget();

    if (!capture.complete || !Number.isSafeInteger(budget) || budget <= 0) {
        return undefined;
    }

    const fake = "0".repeat(48);
    const overhead = options.frame("", {
        bytes: capture.bytes,
        handle: fake,
        next: capture.bytes,
        done: false,
    });
    const overheadBytes = Buffer.byteLength(overhead, "utf8");
    const overheadLines = lineCount(overhead);
    const maxBytes = options.maxBytes ?? 50 * 1024;
    const maxLines = options.maxLines ?? 2_000;
    let allowed = budget;

    for (let attempt = 0; attempt < 4; attempt++) {
        if (allowed < 256) {
            return undefined;
        }

        const page = pageCapture(capture, {
            budget: allowed,
            // Reserve a fixed margin for frame text that depends on the rendered body.
            overheadBytes: overheadBytes + 32,
            overheadLines,
            maxBytes,
            maxLines,
            handle: fake,
            offset: 0,
        });

        if (page.error !== undefined) {
            return undefined;
        }

        if (page.done) {
            const text = options.frame(page.text, {
                bytes: capture.bytes,
                done: true,
            });

            if (Buffer.byteLength(text, "utf8") <= budget && lineCount(text) <= maxLines) {
                return { text };
            }

            allowed -= Math.max(16, Buffer.byteLength(text, "utf8") - budget + 8);
            continue;
        }

        if (page.nextOffset === undefined) {
            return undefined;
        }

        const fakeText = options.frame(page.text, {
            bytes: capture.bytes,
            handle: fake,
            next: page.nextOffset,
            done: false,
        });

        if (Buffer.byteLength(fakeText, "utf8") > budget || lineCount(fakeText) > maxLines) {
            allowed -= Math.max(16, Buffer.byteLength(fakeText, "utf8") - budget + 8);
            continue;
        }

        const snapshot = createOutputSnapshot({
            conversationId: identity.conversationId,
            requester: identity.requester,
            cwd: identity.cwd,
            cwdDev: identity.cwdDev,
            cwdIno: identity.cwdIno,
            configRevision: identity.configRevision,
            sourceCallId,
            text: capture.text,
            offset: page.nextOffset,
        });

        if (snapshot === undefined) {
            return undefined;
        }

        const handle = store.put(snapshot);

        if (handle === undefined) {
            return undefined;
        }

        const text = options.frame(page.text, {
            bytes: capture.bytes,
            handle,
            next: page.nextOffset,
            done: false,
        });

        if (Buffer.byteLength(text, "utf8") <= budget && lineCount(text) <= maxLines) {
            return { text };
        }

        store.delete(handle);
        allowed -= Math.max(16, Buffer.byteLength(text, "utf8") - budget + 8);
    }

    return undefined;
}

/** Build the integration object used by wrapBashQueryOutput. */
export function createQueryBashIntegration(options: QueryRootAdapterOptions): QueryBashIntegration {
    return {
        enabled: options.enabled,
        budget: options.budget,
        store: options.store,
        identity: options.identity,
        eligible: options.eligible,
        trust: options.trust,
        finalCheck: options.finalCheck,
        noteUncovered: options.noteUncovered,
        render: async (capture, identity, store, sourceCallId) =>
            queryRender(options, capture, identity, store, sourceCallId),
    };
}

/** Convenience factory with the existing Ops limits; maxTotalBytes is an internal store bound. */
export function createQueryStore(limits: {
    readonly maxHandles: number;
    readonly maxHandlesPerScope: number;
    readonly handleTtlMs: number;
    readonly maxHandleBytes: number;
}): QuerySnapshotStore {
    return new MemoryQuerySnapshots({
        maxHandles: limits.maxHandles,
        maxHandlesPerScope: limits.maxHandlesPerScope,
        handleTtlMs: limits.handleTtlMs,
        maxHandleBytes: limits.maxHandleBytes,
        // Display-only snapshots share the single-entry cap as their aggregate bound; do not
        // couple this to the owner's scan-byte budget.
        maxTotalBytes: limits.maxHandleBytes,
    });
}
