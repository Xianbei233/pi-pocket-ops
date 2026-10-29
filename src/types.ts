/** Types shared by the pi-pocket-ops drop-in. Kept structural so the module does not need Pi Pocket's type file. */

import type { ReuseOrigin } from "./handles.ts";

/** The public host members this module uses. Pi Pocket's real Host is compatible at run time. */
export interface OpsHost {
    readonly dataDir: string;
    readonly agentDir: string;
    /** Pi Pocket's package version; absent on a host older than 0.16. */
    readonly pocketVersion?: string;
    readonly text: {
        defang(text: string): string;
        quoted(text: string, max?: number): string;
    };
    requesterOf(conversationId: number): string | undefined;
}

/** The public web members this module uses. */
export interface OpsDoc {
    readonly json?: string;
    readonly revision?: number;
    readonly disabled?: boolean;
}

export interface OpsCommandContext {
    readonly conversationId: number;
    readonly user: { readonly role: string };
    readonly context: unknown;
    readonly snapshot?: (doc: unknown, context: unknown) => Promise<OpsDoc | undefined>;
    readonly commit?: <T>(change: (tx: OpsWriteTx) => T | Promise<T>) => Promise<T>;
}

/** The mutable document the owner command and the owner route read and write through CAS. */
export interface OpsConfigValue {
    json: string;
    revision: number;
    disabled: boolean;
}

/** The part of Pi Durable's transaction this module uses. */
export interface OpsWriteTx {
    readonly doc: (doc: unknown) => Promise<OpsConfigValue>;
}

/** A request to an owner-only ops configuration route. */
export interface OpsWebRequest {
    readonly method: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly user: { readonly id?: string; readonly name?: string; readonly role: string };
    readonly context: unknown;
    readonly snapshot?: (doc: unknown, context: unknown) => Promise<OpsDoc | undefined>;
    readonly commit?: <T>(change: (tx: OpsWriteTx) => T | Promise<T>) => Promise<T>;
}

export interface OpsWeb {
    readonly api?: number;
    onDispose(run: () => void | Promise<void>): void;
    route?(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        handler: (request: OpsWebRequest) => unknown,
        options?: { readonly access?: "owner" | "steer" | "view" },
    ): void;
    client?(entry: string, options?: { readonly access?: "owner" | "steer" | "view" }): void;
    error?(status: number, message: string): Error;
    command?(
        name: string,
        command: {
            readonly description: string;
            readonly args?: string;
            readonly scope: "conversation" | "global";
            readonly handler: (
                args: string,
                ctx: OpsCommandContext,
            ) =>
                | {
                      readonly type: "card" | "toast";
                      readonly output?: string;
                      readonly message?: string;
                      readonly level?: string;
                  }
                | Promise<{
                      readonly type: "card" | "toast";
                      readonly output?: string;
                      readonly message?: string;
                      readonly level?: string;
                  }>;
        },
    ): void;
}

/** The part of Chord's Context this module reads. */
export interface OpsContext {
    readonly abortSignal?: AbortSignal;
}

/** How the optional session layer treats an exact repeat of a successful read/search. */
export type DedupMode = "off" | "audit" | "soft";

/** Optional layer settings. It never changes a result unless `dedup` is "soft". */
export interface LayerConfig {
    readonly enabled: boolean;
    readonly dedup: DedupMode;
    /** The built-in `read` path is separate: it always runs first, and only an identical fresh result is compacted. */
    readonly builtinRead: DedupMode;
    readonly builtinReadMinBytes: number;
    readonly builtinReadMinSavingsBytes: number;
    readonly maxEntries: number;
    readonly maxBytes: number;
    /** Global session map bounds; each session also has its own small cache bounds. */
    readonly maxSessions: number;
    readonly sessionTtlMs: number;
}

/** Owner-controlled limits, after validation. */
export interface Limits {
    maxOutputBytes: number;
    maxBatchOutputBytes: number;
    maxFileBytes: number;
    maxSearchFileBytes: number;
    maxScanEntries: number;
    maxScanBytes: number;
    maxDepth: number;
    timeoutMs: number;
    batchTimeoutMs: number;
    maxBatchOps: number;
    batchConcurrency: number;
    batchItemTimeoutMs: number;
    maxMatches: number;
    maxMatchLineBytes: number;
    handleTtlMs: number;
    maxHandles: number;
    maxHandlesPerScope: number;
    maxHandleBytes: number;
}

/** Validated owner configuration. */
export interface Config {
    readonly roots: readonly string[];
    readonly limits: Limits;
    readonly layer: LayerConfig;
    readonly home: string;
    readonly dataDir: string;
    readonly agentDir: string;
}

/** Configuration is read once per module version; an invalid value denies all IO. */
export type ConfigState =
    | { readonly ok: true; readonly config: Config }
    | { readonly ok: false; readonly reason: string };

/** One tool call's trusted identity and folder. */
export interface Scope {
    readonly conversationId: number;
    readonly conversationKey: string;
    readonly requester: string;
    /** Canonical session cwd, with no symlink component. */
    readonly cwd: string;
    /** The allowed root that contains cwd. */
    readonly root: string;
    /** Identity of cwd when the scope was made; a replaced directory is not accepted. */
    readonly cwdStat: StatKey;
    readonly signal: AbortSignal | undefined;
}

/** A file or directory identity, as text so it can live in a JSON-free cache. */
export interface StatKey {
    readonly dev: string;
    readonly ino: string;
    readonly size: number;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
    readonly mode: number;
    readonly nlink: number;
}

/** A byte position: a 1-based line and an absolute byte offset inside the file. */
export interface Cursor {
    readonly line: number;
    readonly byte: number;
}

/** A batch-wide scan budget shared by searches and reads in one ops_batch. */
export interface ScanShare {
    bytes: number;
    entries: number;
    truncated: boolean;
}

/** A rendered page. `origin` is internal replay metadata and is never rendered for the model. */
export interface Page {
    readonly text: string;
    readonly handle?: string;
    readonly done: boolean;
    readonly nextOffset?: number;
    readonly origin?: ReuseOrigin;
    /** Set only by a batch that returns its own summary after an overall timeout. */
    readonly acceptAborted?: boolean;
    /** True when the layer returned a compact replay instead of the full page. */
    readonly reused?: boolean;
}
