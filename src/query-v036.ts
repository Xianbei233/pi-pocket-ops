/**
 * Draft-only 0.3.6 D: historical root-codemode result surface.
 *
 * This does NOT summarize raw child outputs and does NOT merge executions. It can page only the
 * already-returned final plain text of a successful codemode script, with a real nested-call
 * completeness ledger as provenance. Images/errors/spills/unknown output remain native.
 */

import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { type QuerySnapshotIdentity } from "./query-v034.ts";

export const ROOT_SURFACE_MAX_HANDLES = 128;

export interface RootContentPart {
    readonly type: string;
    readonly text?: string;
}

export interface RootCodemodeOutput {
    readonly content?: readonly RootContentPart[];
    readonly details?: unknown;
    readonly diagnostics?: readonly unknown[];
    readonly isError?: boolean;
}

export interface RootGroupEntry {
    readonly name: string;
    readonly status: "pending" | "ok" | "error";
    readonly queryEligible: boolean;
    /** A nested result already contained a real page handle; D stays native to avoid a second paging layer. */
    readonly returnedHandle?: boolean;
}

export interface RootGroupProof {
    readonly entries: readonly RootGroupEntry[];
    readonly taskId: string;
    readonly rootCallId: string;
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
    readonly configRevision: string;
    readonly trusted: boolean;
    readonly complete: boolean;
    readonly closed: boolean;
    readonly dirty: boolean;
    readonly overflow: boolean;
}

export interface RootSurfaceInput {
    readonly output: RootCodemodeOutput;
    readonly group: RootGroupProof;
    readonly outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number };
}

export interface RootSurfaceEligibility {
    readonly eligible: boolean;
    readonly text?: string;
    readonly reason?: string;
}

export interface RootSurfaceSnapshot {
    readonly kind: "codemode-source";
    readonly version: 1;
    readonly conversationId: number;
    readonly requester: string;
    readonly cwd: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
    readonly configRevision: string;
    readonly sourceCallId: string;
    readonly text: string;
    readonly offset: number;
}

export interface RootSurfaceLimits {
    readonly maxHandles: number;
    readonly maxHandlesPerScope?: number;
    readonly maxHandleBytes: number;
    readonly maxTotalBytes: number;
    readonly handleTtlMs: number;
}

export interface RootSurfaceLease {
    readonly handle: string;
    readonly token: string;
    readonly identity: QuerySnapshotIdentity;
    readonly snapshot: RootSurfaceSnapshot;
}

export interface RootSurfaceStore {
    put(snapshot: RootSurfaceSnapshot): string | undefined;
    get(handle: string, identity: QuerySnapshotIdentity): RootSurfaceSnapshot | undefined;
    claim(handle: string, identity: QuerySnapshotIdentity): RootSurfaceLease | undefined;
    commitDone(lease: RootSurfaceLease): boolean;
    advance(lease: RootSurfaceLease, offset: number): boolean;
    release(lease: RootSurfaceLease): void;
    delete(handle: string): void;
    deleteScope(identity: QuerySnapshotIdentity): number;
    dispose(): void;
}

const DETAIL_KEYS = new Set(["calls", "fullOutputPath"]);
const CALL_KEYS = new Set(["name", "status", "duration", "durationMs", "error", "path"]);

function plainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    try {
        if (types.isProxy(value)) {
            return false;
        }

        const prototype = Object.getPrototypeOf(value);

        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

/** Return false for unknown keys/getters/proxies/circular/too-deep details. */
function safeDetails(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
    if (depth > 4 || !plainObject(value)) {
        return false;
    }

    if (seen.has(value)) {
        return false;
    }

    seen.add(value);

    let keys: PropertyKey[];

    try {
        keys = Reflect.ownKeys(value);
    } catch {
        return false;
    }

    if (keys.some((key) => typeof key === "symbol")) {
        return false;
    }

    let descriptors: PropertyDescriptorMap;

    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return false;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!DETAIL_KEYS.has(key) || "get" in descriptor || "set" in descriptor) {
            return false;
        }

        if (key === "fullOutputPath") {
            return false;
        }

        const calls = descriptor.value;

        if (!Array.isArray(calls) || calls.length > 128) {
            return false;
        }

        for (const call of calls) {
            if (!plainObject(call) || seen.has(call)) {
                return false;
            }

            seen.add(call);

            let callDescriptors: PropertyDescriptorMap;

            try {
                callDescriptors = Object.getOwnPropertyDescriptors(call);
            } catch {
                return false;
            }

            for (const [callKey, callDescriptor] of Object.entries(callDescriptors)) {
                if (!CALL_KEYS.has(callKey) || "get" in callDescriptor || "set" in callDescriptor) {
                    return false;
                }

                const callValue = callDescriptor.value;

                if (
                    callValue !== undefined &&
                    (typeof callValue === "string"
                        ? Buffer.byteLength(callValue, "utf8") > 4_096
                        : typeof callValue !== "number" && typeof callValue !== "boolean")
                ) {
                    return false;
                }

                if (typeof callValue === "number" && !Number.isFinite(callValue)) {
                    return false;
                }
            }
        }
    }

    return true;
}

function hasUnsafeRootOutput(output: RootCodemodeOutput): boolean {
    if (output.isError === true) {
        return true;
    }

    if (output.details !== undefined) {
        if (!safeDetails(output.details)) {
            return true;
        }

        if (Object.hasOwn(output.details as object, "fullOutputPath")) {
            return true;
        }
    }

    for (const diagnostic of output.diagnostics ?? []) {
        if (typeof diagnostic !== "object" || diagnostic === null || Array.isArray(diagnostic)) {
            return true;
        }

        try {
            const record = diagnostic as { readonly code?: unknown; readonly message?: unknown };

            if (record.code !== "full_output" && record.code !== "truncated") {
                return true;
            }

            if (record.code === "full_output" || record.code === "truncated") {
                return true;
            }

            const message = typeof record.message === "string" ? record.message : "";

            if (/full output|spill|truncat/iu.test(message)) {
                return true;
            }
        } catch {
            return true;
        }
    }

    return false;
}

export function rootSurfaceBudget(
    limits: { readonly maxOutputBytes: number; readonly maxBatchOutputBytes: number },
    hostBytes = 50 * 1024,
): number {
    const cap = Math.min(limits.maxOutputBytes, limits.maxBatchOutputBytes, hostBytes - 512);

    return Number.isSafeInteger(cap) && cap >= 4 ? cap : 0;
}

export function evaluateRootSurface(input: RootSurfaceInput): RootSurfaceEligibility {
    const content = input.output.content;

    if (input.outputLimits?.maxBytes !== undefined || input.outputLimits?.maxLines !== undefined) {
        return { eligible: false, reason: "custom retained window cannot prove full root text" };
    }

    if (hasUnsafeRootOutput(input.output)) {
        return { eligible: false, reason: "root result is error/spilled/truncated" };
    }

    if (
        content === undefined ||
        content.length === 0 ||
        content.some((part) => part.type !== "text" || typeof part.text !== "string")
    ) {
        return { eligible: false, reason: "root result is not plain text" };
    }

    const group = input.group;

    if (
        group.entries.length < 2 ||
        group.taskId === "" ||
        group.rootCallId === "" ||
        group.requester === "" ||
        group.cwd === "" ||
        group.cwdDev === "" ||
        group.cwdIno === "" ||
        !group.trusted ||
        !group.complete ||
        !group.closed ||
        group.dirty ||
        group.overflow
    ) {
        return { eligible: false, reason: "nested group provenance is incomplete" };
    }

    if (
        group.entries.some(
            (entry) =>
                !entry.queryEligible || entry.status !== "ok" || entry.returnedHandle === true,
        )
    ) {
        return { eligible: false, reason: "nested group is not completed read/query" };
    }

    // The historical snapshot uses the model-readable newline-separated presentation used by
    // opsText, not the raw host byte concatenation. Host eligibility below separately checks
    // the raw boundContent join("") window.
    const text = content.map((part) => part.text ?? "").join("\n");

    if (/<(?:ops_[a-z]+|bash|read)\b[^>]*\bhandle=/u.test(text)) {
        return { eligible: false, reason: "root result already contains a paged child handle" };
    }

    if (
        text === "" ||
        text.includes("\0") ||
        /Warning:\s+truncated output|Full output:/iu.test(text)
    ) {
        return { eligible: false, reason: "root text is empty, binary, or truncated" };
    }

    const rawText = content.map((part) => part.text ?? "").join("");
    const rawLines =
        rawText === ""
            ? 0
            : (rawText.match(/\n/gu)?.length ?? 0) + (rawText.endsWith("\n") ? 0 : 1);
    const readableLines =
        text === "" ? 0 : (text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);

    if (
        Buffer.byteLength(rawText, "utf8") > 50 * 1024 ||
        rawLines > 2_000 ||
        Buffer.byteLength(text, "utf8") > 50 * 1024 ||
        readableLines > 2_000
    ) {
        return { eligible: false, reason: "root text exceeds the original host window" };
    }

    return { eligible: true, text };
}

export function createRootSurfaceSnapshot(
    input: RootSurfaceInput,
    identity: QuerySnapshotIdentity,
    sourceCallId: string,
): RootSurfaceSnapshot | undefined {
    const checked = evaluateRootSurface(input);

    if (
        !checked.eligible ||
        checked.text === undefined ||
        input.group.conversationId !== identity.conversationId ||
        input.group.requester !== identity.requester ||
        input.group.cwd !== identity.cwd ||
        input.group.cwdDev !== identity.cwdDev ||
        input.group.cwdIno !== identity.cwdIno ||
        input.group.configRevision !== identity.configRevision
    ) {
        return undefined;
    }

    return {
        kind: "codemode-source",
        version: 1,
        conversationId: identity.conversationId,
        requester: identity.requester,
        cwd: identity.cwd,
        cwdDev: identity.cwdDev,
        cwdIno: identity.cwdIno,
        configRevision: identity.configRevision,
        sourceCallId,
        text: checked.text,
        offset: 0,
    };
}

function summaryPrefix(text: string, bytes: number): string {
    const buffer = Buffer.from(text, "utf8");

    if (bytes <= 0) {
        return "";
    }

    if (buffer.length <= bytes) {
        return text;
    }

    let cut = bytes;

    while (cut > 0 && (buffer[cut]! & 0xc0) === 0x80) {
        cut--;
    }

    return buffer.subarray(0, cut).toString("utf8");
}

/**
 * The first turn is explicitly a summary plus a full-root handle at offset 0. It is not a
 * body page and does not claim a child-output continuation. Recovery of the handle restarts
 * at byte 0 and reconstructs the full root-returned text.
 */
export function renderRootSurface(
    input: RootSurfaceInput,
    identity: QuerySnapshotIdentity,
    sourceCallId: string,
    store: RootSurfaceStore,
    budget: number,
    frame: (
        body: string,
        meta: {
            readonly bytes: number;
            readonly handle: string;
            readonly offset: 0;
            readonly summary: true;
        },
    ) => string,
): { readonly text: string; readonly handle: string } | undefined {
    const checked = evaluateRootSurface(input);

    if (!checked.eligible || checked.text === undefined) {
        return undefined;
    }

    const snapshot = createRootSurfaceSnapshot(input, identity, sourceCallId);

    if (snapshot === undefined) {
        return undefined;
    }

    const contentCap = Math.min(budget, 50 * 1024);

    if (Buffer.byteLength(checked.text, "utf8") <= contentCap) {
        return undefined;
    }

    const handle = store.put(snapshot);

    if (handle === undefined) {
        return undefined;
    }

    const fake = "0".repeat(48);
    const emptyFrame = frame("", {
        bytes: Buffer.byteLength(checked.text, "utf8"),
        handle: fake,
        offset: 0,
        summary: true,
    });
    let room = contentCap - Buffer.byteLength(emptyFrame, "utf8") - 32;

    for (let attempt = 0; attempt < 4; attempt++) {
        if (room < 4) {
            break;
        }

        const summary = summaryPrefix(checked.text, room);
        const text = frame(summary, {
            bytes: Buffer.byteLength(checked.text, "utf8"),
            handle,
            offset: 0,
            summary: true,
        });

        const lineCountValue =
            text === "" ? 0 : (text.match(/\n/gu)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);

        if (Buffer.byteLength(text, "utf8") <= contentCap && lineCountValue <= 2_000) {
            return { text, handle };
        }

        room = Math.max(4, room - Math.max(16, Buffer.byteLength(text, "utf8") - contentCap + 8));
    }

    store.delete(handle);

    return undefined;
}

/**
 * Cross-call/future-request batching remains blocked: there is no Durable extension active-toolset
 * loadout API and no evidence that can predict future model calls. This module only displays an
 * already-returned root codemode result in the same group.
 */
export const CROSS_CALL_BATCH_BLOCKER =
    "No Durable extension active-toolset/loadout API; cannot predict or merge future tool calls.";

/** Bounded own namespace for root-codemode display handles (no execution cache). */
const ROOT_INVALID_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/u;

function rootOffset(text: string, offset: unknown): offset is number {
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        return false;
    }

    const buffer = Buffer.from(text, "utf8");

    return (
        offset <= buffer.length && (offset === buffer.length || (buffer[offset]! & 0xc0) !== 0x80)
    );
}

export class MemoryRootSurfaces implements RootSurfaceStore {
    private readonly entries = new Map<
        string,
        { snapshot: RootSurfaceSnapshot; expiresAt: number; bytes: number; busy?: string }
    >();
    private readonly limits: RootSurfaceLimits & { readonly maxHandlesPerScope: number };
    private totalBytes = 0;

    constructor(limits: RootSurfaceLimits | number = 60_000) {
        const normalized =
            typeof limits === "number"
                ? {
                      maxHandles: ROOT_SURFACE_MAX_HANDLES,
                      maxHandleBytes: 64 * 1024,
                      maxTotalBytes: 2 * 1024 * 1024,
                      handleTtlMs: limits,
                  }
                : limits;

        if (
            !Number.isSafeInteger(normalized.maxHandles) ||
            normalized.maxHandles <= 0 ||
            !Number.isSafeInteger(normalized.maxHandleBytes) ||
            normalized.maxHandleBytes <= 0 ||
            !Number.isSafeInteger(normalized.maxTotalBytes) ||
            normalized.maxTotalBytes < normalized.maxHandleBytes ||
            !Number.isSafeInteger(normalized.handleTtlMs) ||
            normalized.handleTtlMs <= 0
        ) {
            throw new RangeError("invalid root-surface limits");
        }

        this.limits = {
            ...normalized,
            maxHandlesPerScope:
                normalized.maxHandlesPerScope ?? Math.min(normalized.maxHandles, 32),
        };
    }

    put(snapshot: RootSurfaceSnapshot): string | undefined {
        this.sweep();

        if (!this.valid(snapshot)) {
            return undefined;
        }

        const textBytes = Buffer.byteLength(snapshot.text, "utf8");
        const textLines =
            snapshot.text === ""
                ? 0
                : (snapshot.text.match(/\n/gu)?.length ?? 0) +
                  (snapshot.text.endsWith("\n") ? 0 : 1);

        if (textBytes > 50 * 1024 || textLines > 2_000) {
            return undefined;
        }

        const bytes = this.bytes(snapshot);

        if (bytes > this.limits.maxHandleBytes || this.entries.size >= this.limits.maxHandles) {
            return undefined;
        }

        if (this.totalBytes + bytes > this.limits.maxTotalBytes) {
            return undefined;
        }

        const scope = [
            snapshot.conversationId,
            snapshot.requester,
            snapshot.cwd,
            snapshot.cwdDev,
            snapshot.cwdIno,
        ].join("\u0000");
        let scoped = 0;

        for (const entry of this.entries.values()) {
            const item = entry.snapshot;

            if (
                [item.conversationId, item.requester, item.cwd, item.cwdDev, item.cwdIno].join(
                    "\u0000",
                ) === scope
            ) {
                scoped++;
            }
        }

        if (scoped >= this.limits.maxHandlesPerScope) {
            return undefined;
        }

        const handle = randomBytes(24).toString("hex");

        this.entries.set(handle, {
            snapshot: { ...snapshot },
            expiresAt: Date.now() + this.limits.handleTtlMs,
            bytes,
        });
        this.totalBytes += bytes;

        return handle;
    }

    get(handle: string, identity: QuerySnapshotIdentity): RootSurfaceSnapshot | undefined {
        const entry = this.entries.get(handle);

        if (entry === undefined || Date.now() >= entry.expiresAt) {
            if (entry !== undefined) {
                this.drop(handle);
            }

            return undefined;
        }

        // Wrong scope is a uniform miss; never revoke another requester's handle.
        if (
            !this.sameBase(entry.snapshot, identity) ||
            entry.snapshot.configRevision !== identity.configRevision
        ) {
            return undefined;
        }

        return { ...entry.snapshot };
    }

    claim(handle: string, identity: QuerySnapshotIdentity): RootSurfaceLease | undefined {
        const entry = this.entries.get(handle);

        if (entry === undefined || entry.busy !== undefined || Date.now() >= entry.expiresAt) {
            if (entry !== undefined && Date.now() >= entry.expiresAt) {
                this.drop(handle);
            }

            return undefined;
        }

        if (
            !this.sameBase(entry.snapshot, identity) ||
            entry.snapshot.configRevision !== identity.configRevision
        ) {
            return undefined;
        }

        const token = randomBytes(16).toString("hex");

        entry.busy = token;

        return { handle, token, identity, snapshot: { ...entry.snapshot } };
    }

    commitDone(lease: RootSurfaceLease): boolean {
        const entry = this.entries.get(lease.handle);

        if (
            entry === undefined ||
            entry.busy !== lease.token ||
            Date.now() >= entry.expiresAt ||
            !this.sameBase(entry.snapshot, lease.identity) ||
            entry.snapshot.configRevision !== lease.identity.configRevision
        ) {
            return false;
        }

        this.drop(lease.handle);

        return true;
    }

    advance(lease: RootSurfaceLease, offset: number): boolean {
        const entry = this.entries.get(lease.handle);

        if (entry === undefined || entry.busy !== lease.token || Date.now() >= entry.expiresAt) {
            return false;
        }

        if (
            !this.sameBase(entry.snapshot, lease.identity) ||
            entry.snapshot.configRevision !== lease.identity.configRevision ||
            !rootOffset(entry.snapshot.text, offset) ||
            offset <= entry.snapshot.offset
        ) {
            return false;
        }

        const next = { ...entry.snapshot, offset };
        const nextBytes = this.bytes(next);

        if (this.totalBytes - entry.bytes + nextBytes > this.limits.maxTotalBytes) {
            return false;
        }

        const oldBytes = entry.bytes;

        entry.snapshot = next;
        entry.bytes = nextBytes;
        this.totalBytes += nextBytes - oldBytes;
        entry.busy = undefined;

        return true;
    }

    release(lease: RootSurfaceLease): void {
        const entry = this.entries.get(lease.handle);

        if (entry?.busy === lease.token) {
            entry.busy = undefined;
        }
    }

    delete(handle: string): void {
        this.drop(handle);
    }

    deleteScope(identity: QuerySnapshotIdentity): number {
        let deleted = 0;

        for (const [handle, entry] of this.entries) {
            if (this.sameBase(entry.snapshot, identity)) {
                this.drop(handle);
                deleted++;
            }
        }

        return deleted;
    }

    dispose(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    private valid(snapshot: RootSurfaceSnapshot): boolean {
        return (
            snapshot.kind === "codemode-source" &&
            snapshot.version === 1 &&
            snapshot.offset === 0 &&
            Number.isSafeInteger(snapshot.conversationId) &&
            snapshot.conversationId >= 0 &&
            typeof snapshot.requester === "string" &&
            snapshot.requester.length > 0 &&
            snapshot.requester.isWellFormed() &&
            typeof snapshot.cwd === "string" &&
            snapshot.cwd.length > 0 &&
            snapshot.cwd.isWellFormed() &&
            typeof snapshot.cwdDev === "string" &&
            snapshot.cwdDev.length > 0 &&
            snapshot.cwdDev.isWellFormed() &&
            typeof snapshot.cwdIno === "string" &&
            snapshot.cwdIno.length > 0 &&
            snapshot.cwdIno.isWellFormed() &&
            typeof snapshot.configRevision === "string" &&
            snapshot.configRevision.length > 0 &&
            snapshot.configRevision.isWellFormed() &&
            typeof snapshot.sourceCallId === "string" &&
            snapshot.sourceCallId.length > 0 &&
            snapshot.sourceCallId.isWellFormed() &&
            typeof snapshot.text === "string" &&
            snapshot.text.isWellFormed() &&
            !snapshot.text.includes("\0") &&
            !ROOT_INVALID_OUTPUT.test(snapshot.text)
        );
    }

    private bytes(snapshot: RootSurfaceSnapshot): number {
        return Buffer.byteLength(JSON.stringify(snapshot), "utf8") + 64;
    }

    private sameBase(snapshot: RootSurfaceSnapshot, identity: QuerySnapshotIdentity): boolean {
        return (
            snapshot.conversationId === identity.conversationId &&
            snapshot.requester === identity.requester &&
            snapshot.cwd === identity.cwd &&
            snapshot.cwdDev === identity.cwdDev &&
            snapshot.cwdIno === identity.cwdIno
        );
    }

    private sweep(): void {
        const now = Date.now();

        for (const [handle, entry] of this.entries) {
            if (now >= entry.expiresAt) {
                this.drop(handle);
            }
        }
    }

    private drop(handle: string): void {
        const entry = this.entries.get(handle);

        if (entry !== undefined) {
            this.totalBytes -= entry.bytes;
            this.entries.delete(handle);
        }
    }
}
