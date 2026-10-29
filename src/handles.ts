/**
 * Disposable in-memory page handles.
 *
 * A handle is random, scoped to conversation + requester + canonical cwd, TTL-bound, capacity-bound, and never
 * persisted. Disposal aborts in-flight calls and drops every handle; restart/reload therefore invalidates all handles.
 */

import { randomBytes } from "node:crypto";
import { OpsError } from "./errors.ts";
import type { Cursor, Limits, StatKey } from "./types.ts";

export interface ReadSnapshot {
    readonly kind: "read";
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly root: string;
    readonly cwdStat: StatKey;
    readonly segments: readonly string[];
    readonly path: string;
    readonly ref: string;
    readonly stat: StatKey;
    readonly hash: string;
    readonly cursor: Cursor;
    /** Last line of the original requested window; a resume never reads past it. */
    readonly endLine: number;
}

export interface SearchDir {
    readonly segments: readonly string[];
    readonly path: string;
    readonly stat: StatKey;
}

export interface SearchFile {
    readonly segments: readonly string[];
    readonly path: string;
    readonly stat: StatKey;
    /** Present for files whose text was read; a resume re-hashes these. */
    readonly hash?: string;
}

export interface SearchSnapshot {
    readonly kind: "search";
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly root: string;
    readonly cwdStat: StatKey;
    readonly mode: "files" | "text";
    readonly path: string;
    readonly segments: readonly string[];
    readonly query: string;
    readonly scanned: number;
    readonly items: readonly string[];
    readonly next: number;
    readonly dirs: readonly SearchDir[];
    readonly files: readonly SearchFile[];
    readonly scanTruncated: boolean;
    readonly depthTruncated: boolean;
    readonly skipped: number;
}

/** The exact text of an earlier successful built-in `read`, replayed only while its mutation epoch is current. */
export interface TextSnapshot {
    readonly kind: "text";
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly root: string;
    readonly cwdStat: StatKey;
    readonly label: string;
    readonly segments: readonly string[];
    readonly stat: StatKey;
    readonly text: string;
    readonly epoch: number;
    /** Byte offset of the next replay chunk. */
    readonly offset: number;
}

export type Snapshot = ReadSnapshot | SearchSnapshot | TextSnapshot;

/** Replay metadata for a successful read; the start cursor is the original window start, not the page end. */
export interface ReadOrigin {
    readonly kind: "read";
    readonly snapshot: ReadSnapshot;
    readonly start: Cursor;
    readonly budget: number;
    readonly complete: boolean;
}

/** Replay metadata for a successful search; `next` is zero so a replay starts at the first result. */
export interface SearchOrigin {
    readonly kind: "search";
    readonly snapshot: SearchSnapshot;
    readonly budget: number;
    readonly complete: boolean;
}

export type ReuseOrigin = ReadOrigin | SearchOrigin;

export interface Entry {
    readonly handle: string;
    snapshot: Snapshot;
    bytes: number;
    readonly createdAt: number;
    expiresAt: number;
    busy: boolean;
}

export type Lookup = { readonly kind: "ok"; readonly entry: Entry } | { readonly kind: "busy" };

export function scopeKey(conversationId: number, requester: string, cwd: string): string {
    return `${conversationId}\u0000${requester}\u0000${cwd}`;
}

const HANDLE = /^[a-f0-9]{48}$/u;

export class HandleStore {
    private readonly entries = new Map<string, Entry>();
    private readonly controllers = new Set<AbortController>();
    private bytes = 0;
    private disposed = false;
    private readonly limits: Limits;

    constructor(limits: Limits) {
        this.limits = limits;
    }

    /** Drop expired handles; called before capacity decisions and lookups. */
    sweep(now = Date.now()): void {
        for (const [handle, entry] of this.entries) {
            if (now >= entry.expiresAt) {
                this.delete(handle);
            }
        }
    }

    create(snapshot: Snapshot, bytes: number): string | undefined {
        if (this.disposed) {
            return undefined;
        }

        this.sweep();

        if (bytes > this.limits.maxHandleBytes) {
            return undefined;
        }

        const now = Date.now();
        const key = scopeKey(snapshot.conversationId, snapshot.requester, snapshot.cwd);

        const evictUntil = (): boolean => {
            for (;;) {
                const scopeCount = [...this.entries.values()].filter(
                    (entry) =>
                        scopeKey(
                            entry.snapshot.conversationId,
                            entry.snapshot.requester,
                            entry.snapshot.cwd,
                        ) === key,
                ).length;

                if (scopeCount < this.limits.maxHandlesPerScope) {
                    break;
                }

                if (!this.evictOldest(key)) {
                    return false;
                }
            }

            for (;;) {
                if (this.entries.size < this.limits.maxHandles) {
                    break;
                }

                if (!this.evictOldest()) {
                    return false;
                }
            }

            for (;;) {
                if (this.bytes + bytes <= this.limits.maxHandleBytes) {
                    break;
                }

                if (!this.evictOldest()) {
                    return false;
                }
            }

            return true;
        };

        if (!evictUntil()) {
            return undefined;
        }

        const handle = randomBytes(24).toString("hex");
        const entry: Entry = {
            handle,
            snapshot,
            bytes,
            createdAt: now,
            expiresAt: now + this.limits.handleTtlMs,
            busy: false,
        };

        this.entries.set(handle, entry);
        this.bytes += bytes;

        return handle;
    }

    private evictOldest(scope?: string, except?: string, skipBusy = false): boolean {
        let oldest: Entry | undefined;

        for (const entry of this.entries.values()) {
            if (
                scope !== undefined &&
                scopeKey(
                    entry.snapshot.conversationId,
                    entry.snapshot.requester,
                    entry.snapshot.cwd,
                ) !== scope
            ) {
                continue;
            }

            if (entry.handle === except || (skipBusy && entry.busy)) {
                continue;
            }

            if (oldest === undefined || entry.createdAt < oldest.createdAt) {
                oldest = entry;
            }
        }

        if (oldest === undefined) {
            return false;
        }

        this.delete(oldest.handle);

        return true;
    }

    lookup(
        handle: unknown,
        conversationId: number,
        requester: string,
        cwd: string,
    ): Lookup | undefined {
        if (this.disposed || typeof handle !== "string" || !HANDLE.test(handle)) {
            return undefined;
        }

        this.sweep();

        const entry = this.entries.get(handle);

        if (entry === undefined) {
            return undefined;
        }

        if (
            entry.snapshot.conversationId !== conversationId ||
            entry.snapshot.requester !== requester ||
            entry.snapshot.cwd !== cwd
        ) {
            // A different scope must not be able to revoke the original owner's handle.
            return undefined;
        }

        if (entry.busy) {
            return { kind: "busy" };
        }

        return { kind: "ok", entry };
    }

    /**
     * Replace a snapshot after a successful page, keeping the aggregate byte cap. Busy entries and this handle are
     * never evicted. If the new snapshot cannot fit, this handle is invalidated and false is returned, so the caller
     * must use the unified handle-miss fallback rather than returning an unregistered cursor.
     */
    update(handle: string, snapshot: Snapshot): boolean {
        const entry = this.entries.get(handle);

        if (entry === undefined) {
            return false;
        }

        const bytes = estimateSnapshotBytes(snapshot);

        if (bytes > this.limits.maxHandleBytes) {
            this.delete(handle);

            return false;
        }

        const delta = bytes - entry.bytes;

        while (this.bytes + delta > this.limits.maxHandleBytes) {
            if (!this.evictOldest(undefined, handle, true)) {
                this.delete(handle);

                return false;
            }
        }

        this.bytes += delta;
        entry.bytes = bytes;
        entry.snapshot = snapshot;

        return true;
    }

    touch(handle: string): void {
        const entry = this.entries.get(handle);

        if (entry !== undefined) {
            entry.expiresAt = Date.now() + this.limits.handleTtlMs;
        }
    }

    setBusy(handle: string, busy: boolean): void {
        const entry = this.entries.get(handle);

        if (entry !== undefined) {
            entry.busy = busy;
        }
    }

    /** Revoke every handle for one trusted scope, never another requester's or conversation's. */
    deleteScope(conversationId: number, requester: string, cwd: string): void {
        for (const [handle, entry] of this.entries) {
            if (
                entry.snapshot.conversationId === conversationId &&
                entry.snapshot.requester === requester &&
                entry.snapshot.cwd === cwd
            ) {
                this.delete(handle);
            }
        }
    }

    delete(handle: string): void {
        const entry = this.entries.get(handle);

        if (entry !== undefined) {
            this.entries.delete(handle);
            this.bytes -= entry.bytes;
        }
    }

    /** Track one call's controller so disposal aborts it. */
    track(controller: AbortController): () => void {
        if (this.disposed) {
            controller.abort("ops-disposed");

            return () => {};
        }

        this.controllers.add(controller);

        return () => {
            this.controllers.delete(controller);
        };
    }

    dispose(): void {
        this.disposed = true;

        for (const controller of this.controllers) {
            controller.abort("ops-disposed");
        }

        this.controllers.clear();
        this.entries.clear();
        this.bytes = 0;
    }

    get size(): number {
        return this.entries.size;
    }
}

/** A conservative in-memory size for one snapshot. */
export function estimateSnapshotBytes(snapshot: Snapshot): number {
    return Buffer.byteLength(JSON.stringify(snapshot), "utf8") + 256;
}

/** Translate a store miss into the one error that never confirms whether a handle existed. */
export function handleMiss(): never {
    throw new OpsError(
        "handle",
        "ops: handle not found, expired, or no longer valid; call the original tool again",
    );
}
