/**
 * The optional session layer: deterministic repeat suppression for successful reads and searches, plus the
 * mutation invalidation that makes it safe. It is a soft gate, not an access control, and it never runs a tool
 * without the ordinary beforeTool hooks (including Lancet Guard) having passed.
 */

import { ToolTask } from "@earendil-works/pi-durable";
import type {
    Config,
    ConfigState,
    DedupMode,
    OpsContext,
    OpsHost,
    Page,
    Scope,
    StatKey,
} from "./types.ts";
import { OpsError, safeErrorMessage } from "./errors.ts";
import {
    estimateSnapshotBytes,
    type HandleStore,
    type ReadOrigin,
    type ReuseOrigin,
    type SearchOrigin,
    type TextSnapshot,
} from "./handles.ts";
import { statRegular } from "./fs-safe.ts";
import { sameStat } from "./paths.ts";
import { readIdentity, type ReadArgs, type ReadIdentity } from "./read.ts";
import {
    searchIdentity,
    verifySearchSnapshot,
    type SearchArgs,
    type SearchIdentity,
} from "./search.ts";
import { readReuseHit, searchReuseHit } from "./compact.ts";
import { builtinReadHit } from "./replay.ts";
import { byteLength } from "./render.ts";

const READER_TOOLS = new Set([
    "read",
    "ops_read",
    "ops_search",
    "ops_check",
    "ops_batch",
    "ops_result",
]);

export interface OpsApi {
    readonly conversationId: number;
    readonly callId?: string;
    agent(context: OpsContext): Promise<{
        readonly cwd?: string;
        readonly extensions?: readonly {
            readonly name: string;
            readonly hooks?: readonly {
                readonly task: string;
                readonly handlers: { readonly afterTool?: unknown };
            }[];
            readonly wraps?: readonly ({ readonly tool: string } | { readonly section: string })[];
        }[];
    }>;
    diagnostic?(diagnostic: {
        severity: "info" | "warn" | "error";
        message: string;
        code?: string;
    }): void;
}

interface BuiltinEntry {
    readonly text: string;
    readonly epoch: number;
    readonly bytes: number;
    readonly at: number;
}

interface CacheEntry {
    readonly key: string;
    readonly origin: ReuseOrigin;
    readonly epoch: number;
    readonly ref: string;
    readonly bytes: number;
    readonly originalBytes: number;
    readonly at: number;
}

interface Stats {
    reads: number;
    searches: number;
    checks: number;
    hits: number;
    misses: number;
    bypasses: number;
    errors: number;
    omittedBytes: number;
    mutations: number;
    lastMutation: string;
    builtinHits: number;
    builtinAudit: number;
    builtinSkipped: number;
}

interface SessionState {
    readonly conversationId: number;
    lastUsed: number;
    epoch: number;
    /** Once a foreign reader/result wrapper is observed, replay stays off for this session until reload. */
    foreignSeen: boolean;
    cache: Map<string, CacheEntry>;
    cacheBytes: number;
    builtin: Map<string, BuiltinEntry>;
    builtinBytes: number;
    stats: Stats;
}

export interface LayerStatsView extends Stats {
    readonly conversationId: number;
    readonly epoch: number;
    readonly cacheEntries: number;
    readonly cacheBytes: number;
    readonly mode: DedupMode;
    readonly enabled: boolean;
}

function emptyStats(): Stats {
    return {
        reads: 0,
        searches: 0,
        checks: 0,
        hits: 0,
        misses: 0,
        bypasses: 0,
        errors: 0,
        omittedBytes: 0,
        mutations: 0,
        lastMutation: "none",
        builtinHits: 0,
        builtinAudit: 0,
        builtinSkipped: 0,
    };
}

function keyOf(conversationId: number, parts: readonly (string | number)[]): string {
    return [conversationId, ...parts].join("\u0000");
}

/** Deterministic JSON for an argument object; the built-in read has no canonical key of its own. */
function stable(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((each) => stable(each)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

/** Re-check the request identity after an await; a mutation or a replaced folder makes the entry unusable. */
function stillCurrent(session: SessionState, entry: CacheEntry): boolean {
    return session.epoch === entry.epoch && session.cache.get(entry.key) === entry;
}

export class SessionLayer {
    readonly enabled: boolean;
    readonly mode: DedupMode;
    private readonly host: OpsHost;
    private readonly store: HandleStore;
    private readonly state: ConfigState;
    private readonly sessions = new Map<number, SessionState>();
    private readonly uncovered = new Map<number, number>();
    /** Monotonic across sessions so an evicted session's text handle cannot revive with a reset epoch. */
    private generation = 0;

    constructor(host: OpsHost, state: ConfigState, store: HandleStore) {
        this.host = host;
        this.state = state;
        this.store = store;
        this.enabled = state.ok && state.config.layer.enabled;
        this.mode = state.ok && state.config.layer.enabled ? state.config.layer.dedup : "off";
    }

    /** The config when it is valid; otherwise the layer does nothing. */
    private config(): Config | undefined {
        return this.state.ok && this.enabled ? this.state.config : undefined;
    }

    /** Drop sessions whose TTL elapsed, even if this is the same session's next access. */
    private sweepExpired(now: number): void {
        const ttl = this.config()?.layer.sessionTtlMs ?? 900_000;
        const max = this.config()?.layer.maxSessions ?? 64;

        for (const [id, session] of this.sessions) {
            if (now - session.lastUsed > ttl) {
                this.sessions.delete(id);
                this.uncovered.delete(id);
            }
        }

        this.sweepUncovered(now, max, ttl);
    }

    /** Make room for one new session without evicting an existing session that was just accessed. */
    private enforceCap(): void {
        const max = this.config()?.layer.maxSessions ?? 64;

        while (this.sessions.size >= max) {
            let oldest: SessionState | undefined;

            for (const candidate of this.sessions.values()) {
                if (oldest === undefined || candidate.lastUsed < oldest.lastUsed) {
                    oldest = candidate;
                }
            }

            if (oldest === undefined) {
                break;
            }

            this.sessions.delete(oldest.conversationId);
            this.uncovered.delete(oldest.conversationId);
        }
    }

    /** Bound the uncovered markers too: they can be set before any session cache exists. */
    private sweepUncovered(now: number, max: number, ttl: number): void {
        for (const [id, at] of this.uncovered) {
            if (now - at > ttl) {
                this.uncovered.delete(id);
            }
        }

        while (this.uncovered.size >= max) {
            let oldest: number | undefined;
            let oldestAt = Infinity;

            for (const [id, at] of this.uncovered) {
                if (at < oldestAt) {
                    oldest = id;
                    oldestAt = at;
                }
            }

            if (oldest === undefined) {
                break;
            }

            this.uncovered.delete(oldest);
        }
    }

    private session(conversationId: number): SessionState {
        const now = Date.now();

        this.sweepExpired(now);
        const existing = this.sessions.get(conversationId);

        if (existing !== undefined) {
            existing.lastUsed = now;

            return existing;
        }

        this.enforceCap();
        const found: SessionState = {
            conversationId,
            lastUsed: now,
            epoch: ++this.generation,
            foreignSeen: false,
            cache: new Map(),
            cacheBytes: 0,
            builtin: new Map(),
            builtinBytes: 0,
            stats: emptyStats(),
        };

        this.sessions.set(conversationId, found);

        return found;
    }

    /** After any tool that is not a known pure reader. Conservative by design: an unknown tool may write. */
    invalidate(conversationId: number, tool: string): void {
        if (!this.enabled) {
            return;
        }

        const session = this.session(conversationId);

        session.epoch++;
        session.cache.clear();
        session.cacheBytes = 0;
        session.builtin.clear();
        session.builtinBytes = 0;
        session.stats.mutations++;
        session.stats.lastMutation = tool;
    }

    /**
     * A foreign ToolTask afterTool hook can transform or redact a result after this layer has cached it. Replaying that
     * cached text through ops_result would bypass the other module's transform, so the layer stands down.
     */
    allowsReplay(
        agent: {
            readonly extensions?: readonly {
                readonly name: string;
                readonly hooks?: readonly {
                    readonly task: string;
                    readonly handlers: { readonly afterTool?: unknown };
                }[];
                readonly wraps?: readonly (
                    { readonly tool: string } | { readonly section: string }
                )[];
            }[];
        },
        conversationId: number,
    ): boolean {
        const session = this.session(conversationId);

        if (session.foreignSeen) {
            return false;
        }

        const task = ToolTask.definition.name;
        const readers = READER_TOOLS;
        let foreign = false;

        for (const extension of agent.extensions ?? []) {
            if (extension.name === "pi-pocket-ops") {
                continue;
            }

            for (const wrap of extension.wraps ?? []) {
                if ("tool" in wrap && readers.has(wrap.tool)) {
                    foreign = true;
                }
            }

            for (const hook of extension.hooks ?? []) {
                if (hook.task === task && typeof hook.handlers.afterTool === "function") {
                    foreign = true;
                }
            }
        }

        if (foreign) {
            session.foreignSeen = true;

            return false;
        }

        return true;
    }

    /** Revoke this scope's handles and caches; never another requester's or conversation's. */
    standDown(scope: Scope): void {
        const session = this.sessions.get(scope.conversationId);

        if (session !== undefined) {
            session.epoch = ++this.generation;
            session.cache.clear();
            session.cacheBytes = 0;
            session.builtin.clear();
            session.builtinBytes = 0;
        }

        this.store.deleteScope(scope.conversationId, scope.requester, scope.cwd);
    }

    /** Say once per session why a built-in read is outside the covered scope; never repeat it on every call. */
    noteUncovered(conversationId: number, reason: string): string | undefined {
        if (!this.enabled || this.uncovered.has(conversationId)) {
            return undefined;
        }

        const now = Date.now();
        const config = this.config();

        this.sweepUncovered(
            now,
            config?.layer.maxSessions ?? 64,
            config?.layer.sessionTtlMs ?? 900_000,
        );
        this.uncovered.set(conversationId, now);

        return `Built-in read passthrough: ${reason}. Repeat suppression is not applied to this session's built-in read.`;
    }

    noteError(conversationId: number): void {
        if (!this.enabled) {
            return;
        }

        this.session(conversationId).stats.errors++;
    }

    private canReuse(fresh: boolean | undefined): boolean {
        return this.enabled && this.mode !== "off" && fresh !== true;
    }

    /** Read through the session layer. `run` is the ordinary read, with the ordinary scope and cancellation. */
    async read(
        args: ReadArgs,
        scope: Scope,
        api: OpsApi,
        context: OpsContext,
        run: () => Promise<Page>,
        created?: Set<string>,
    ): Promise<Page> {
        const config = this.config();

        if (config === undefined) {
            return run();
        }

        const agent = await api.agent(context);

        if (!this.allowsReplay(agent, scope.conversationId)) {
            this.standDown(scope);
            const note = this.noteUncovered(
                scope.conversationId,
                "another extension has a reader/result wrapper or ToolTask afterTool hook; repeat replay is disabled",
            );

            if (note !== undefined) {
                api.diagnostic?.({ severity: "info", code: "ops-uncovered", message: note });
            }

            return run();
        }

        const session = this.session(scope.conversationId);

        session.stats.reads++;

        const startEpoch = session.epoch;
        let duplicate: CacheEntry | undefined;

        if (this.canReuse(args.fresh)) {
            duplicate = await this.reusable(session, args, scope, config);

            if (duplicate !== undefined && this.mode === "soft") {
                const replay = this.replayRead(duplicate, session, scope, args, created);

                if (replay !== undefined) {
                    session.stats.hits++;
                    session.stats.omittedBytes += duplicate.originalBytes;
                    this.touch(session, duplicate);

                    return replay;
                }
            }

            if (duplicate !== undefined && this.mode === "audit") {
                session.stats.hits++;
                api.diagnostic?.({
                    severity: "info",
                    code: "ops-dedup",
                    message:
                        "This is an exact repeat of a successful read in this session; audit mode kept the full result.",
                });
            }
        }

        const page = await run();

        if (page.origin?.kind === "read" && session.epoch === startEpoch) {
            this.remember(session, args, page.origin, page.text, config);
        } else if (!this.canReuse(args.fresh)) {
            session.stats.misses++;
        }

        return page;
    }

    /** Search through the session layer. */
    async search(
        args: SearchArgs,
        scope: Scope,
        api: OpsApi,
        context: OpsContext,
        run: () => Promise<Page>,
        created?: Set<string>,
        allowReuse = true,
    ): Promise<Page> {
        const config = this.config();

        if (config === undefined) {
            return run();
        }

        const agent = await api.agent(context);

        if (!this.allowsReplay(agent, scope.conversationId)) {
            this.standDown(scope);
            const note = this.noteUncovered(
                scope.conversationId,
                "another extension has a reader/result wrapper or ToolTask afterTool hook; repeat replay is disabled",
            );

            if (note !== undefined) {
                api.diagnostic?.({ severity: "info", code: "ops-uncovered", message: note });
            }

            return run();
        }

        const session = this.session(scope.conversationId);

        session.stats.searches++;

        const startEpoch = session.epoch;
        let duplicate: CacheEntry | undefined;

        if (allowReuse && this.canReuse(args.fresh)) {
            duplicate = await this.reusableSearch(session, args, scope, config);

            if (duplicate !== undefined && this.mode === "soft") {
                const replay = this.replaySearch(duplicate, session, scope, args, created);

                if (replay !== undefined) {
                    session.stats.hits++;
                    session.stats.omittedBytes += duplicate.originalBytes;
                    this.touch(session, duplicate);

                    return replay;
                }
            }

            if (duplicate !== undefined && this.mode === "audit") {
                session.stats.hits++;
                api.diagnostic?.({
                    severity: "info",
                    code: "ops-dedup",
                    message:
                        "This is an exact repeat of a successful search in this session; audit mode kept the full result.",
                });
            }
        }

        const page = await run();

        if (page.origin?.kind === "search" && session.epoch === startEpoch) {
            this.remember(session, args, page.origin, page.text, config);
        } else if (!this.canReuse(args.fresh)) {
            session.stats.misses++;
        }

        return page;
    }

    /** The identity a prior successful read recorded, for `ops_check`. */
    known(conversationId: number, path: string): { stat: StatKey } | undefined {
        const session = this.sessions.get(conversationId);

        if (session === undefined) {
            return undefined;
        }

        let newest: CacheEntry | undefined;

        for (const entry of session.cache.values()) {
            if (entry.origin.kind === "read" && entry.origin.snapshot.path === path) {
                if (newest === undefined || entry.at > newest.at) {
                    newest = entry;
                }
            }
        }

        return newest?.origin.kind === "read" ? { stat: newest.origin.snapshot.stat } : undefined;
    }

    noteCheck(conversationId: number): void {
        if (!this.enabled) {
            return;
        }

        this.session(conversationId).stats.checks++;
    }

    /** The mutation epoch a text replay handle must match. A missing session never matches a live handle. */
    currentEpoch(conversationId: number): number {
        return this.sessions.get(conversationId)?.epoch ?? 0;
    }

    /**
     * Decide what to do after the built-in `read` has already returned. The comparison is against the fresh text,
     * so this never serves stale file data and never claims to save the read itself.
     */
    suppressBuiltinRead(
        args: unknown,
        text: string,
        scope: Scope,
        identity?: {
            readonly segments: readonly string[];
            readonly path: string;
            readonly stat: StatKey;
        },
        created?: Set<string>,
    ): { readonly hit?: string; readonly handle?: string } {
        const config = this.config();

        if (config === undefined) {
            return {};
        }

        const mode = config.layer.builtinRead;

        if (mode === "off") {
            return {};
        }

        const session = this.session(scope.conversationId);
        const key = keyOf(session.conversationId, ["b", scope.requester, scope.cwd, stable(args)]);
        const bytes = byteLength(text);
        const previous = session.builtin.get(key);
        const duplicate =
            previous !== undefined && previous.epoch === session.epoch && previous.text === text;

        if (duplicate && mode === "audit") {
            session.stats.builtinAudit++;
            this.rememberBuiltin(session, key, text, bytes, config);

            return {};
        }

        if (duplicate && bytes >= config.layer.builtinReadMinBytes) {
            const label =
                identity?.path ??
                (typeof (args as { readonly path?: unknown } | null)?.path === "string"
                    ? (args as { readonly path: string }).path
                    : "read");
            const raw = args as {
                readonly offset?: unknown;
                readonly limit?: unknown;
            };
            const offset =
                typeof raw.offset === "number" &&
                Number.isSafeInteger(raw.offset) &&
                raw.offset >= 1
                    ? raw.offset
                    : undefined;
            const limit =
                typeof raw.limit === "number" && Number.isSafeInteger(raw.limit) && raw.limit >= 1
                    ? Math.min(2000, raw.limit)
                    : undefined;
            const sample = JSON.stringify({
                operations: [
                    {
                        tool: "ops_read",
                        path: label,
                        ...(offset === undefined ? {} : { offset }),
                        ...(limit === undefined ? {} : { limit }),
                    },
                ],
            });
            let handle: string | undefined;

            if (identity !== undefined) {
                const snapshot: TextSnapshot = {
                    kind: "text",
                    conversationId: scope.conversationId,
                    requester: scope.requester,
                    cwd: scope.cwd,
                    root: scope.root,
                    cwdStat: scope.cwdStat,
                    label: identity.path,
                    segments: identity.segments,
                    stat: identity.stat,
                    text,
                    epoch: session.epoch,
                    offset: 0,
                };

                handle = this.store.create(snapshot, estimateSnapshotBytes(snapshot));
            }

            const hit = builtinReadHit(this.host, label, bytes, handle, sample);

            if (byteLength(hit) + config.layer.builtinReadMinSavingsBytes < bytes) {
                if (handle !== undefined) {
                    created?.add(handle);
                }

                session.stats.builtinHits++;

                return handle === undefined ? { hit } : { hit, handle };
            }

            if (handle !== undefined) {
                this.store.delete(handle);
            }

            session.stats.builtinSkipped++;
            this.rememberBuiltin(session, key, text, bytes, config);

            return {};
        }

        if (duplicate) {
            session.stats.builtinSkipped++;
        }

        this.rememberBuiltin(session, key, text, bytes, config);

        return {};
    }

    private rememberBuiltin(
        session: SessionState,
        key: string,
        text: string,
        bytes: number,
        config: Config,
    ): void {
        const existing = session.builtin.get(key);

        if (existing !== undefined) {
            session.builtin.delete(key);
            session.builtinBytes -= existing.bytes;
        }

        if (bytes > config.layer.maxBytes) {
            return;
        }

        while (
            session.builtin.size >= config.layer.maxEntries ||
            session.builtinBytes + bytes > config.layer.maxBytes
        ) {
            const oldest = session.builtin.keys().next().value;

            if (oldest === undefined) {
                break;
            }

            const entry = session.builtin.get(oldest);

            session.builtin.delete(oldest);

            if (entry !== undefined) {
                session.builtinBytes -= entry.bytes;
            }
        }

        session.builtin.set(key, { text, epoch: session.epoch, bytes, at: Date.now() });
        session.builtinBytes += bytes;
    }

    stats(conversationId: number): LayerStatsView {
        const session = this.session(conversationId);

        return {
            ...session.stats,
            conversationId,
            epoch: session.epoch,
            cacheEntries: session.cache.size,
            cacheBytes: session.cacheBytes,
            mode: this.mode,
            enabled: this.enabled,
        };
    }

    /** One short card for `/ops-stats`; no file names, content, or secrets. */
    statsText(conversationId: number): string {
        const view = this.stats(conversationId);
        const config = this.state.ok ? this.state.config : undefined;

        return [
            `pi-pocket-ops session layer: ${view.enabled ? "on" : "off"} (dedup ${view.mode})`,
            `requests read=${view.reads} search=${view.searches} check=${view.checks}`,
            `dedup hits=${view.hits} misses=${view.misses} bypasses=${view.bypasses}`,
            `omitted-byte estimate=${view.omittedBytes}`,
            `cache entries=${view.cacheEntries} bytes=${view.cacheBytes} epoch=${view.epoch}`,
            `mutations seen=${view.mutations} last=${view.lastMutation}`,
            `builtin read: hits=${view.builtinHits} audit=${view.builtinAudit} skipped-small=${view.builtinSkipped}`,
            "This layer only suppresses repeated output; it does not merge calls or reduce rounds already made.",
            "The sample ops_batch in a hit is data only; nothing was executed automatically.",
            `errors=${view.errors}`,
            config === undefined
                ? "configuration invalid: file IO is denied"
                : `limits: dedup entries=${config.layer.maxEntries} bytes=${config.layer.maxBytes}, ` +
                  `batch concurrency max=${config.limits.batchConcurrency}`,
            "The gate is a repeat-suppression optimization, not a security boundary.",
        ].join("\n");
    }

    private async reusable(
        session: SessionState,
        args: ReadArgs,
        scope: Scope,
        config: Config,
    ): Promise<CacheEntry | undefined> {
        let identity;

        try {
            identity = readIdentity(args, config);
        } catch {
            return undefined;
        }

        const key = keyOf(session.conversationId, [
            "r",
            scope.requester,
            scope.cwd,
            identity.path,
            identity.offset,
            identity.limit,
            identity.budget,
        ]);
        const entry = session.cache.get(key);

        if (
            entry === undefined ||
            !stillCurrent(session, entry) ||
            entry.origin.kind !== "read" ||
            entry.origin.snapshot.cwdStat.dev !== scope.cwdStat.dev ||
            entry.origin.snapshot.cwdStat.ino !== scope.cwdStat.ino
        ) {
            this.drop(session, key);

            return undefined;
        }

        let stat;

        try {
            stat = await statRegular(
                scope,
                entry.origin.snapshot.segments,
                config.limits.maxFileBytes,
            );
        } catch (error) {
            if (this.fatal(error)) {
                throw error;
            }

            this.drop(session, key);

            return undefined;
        }

        if (!sameStat(entry.origin.snapshot.stat, stat) || !stillCurrent(session, entry)) {
            this.drop(session, key);

            return undefined;
        }

        return entry;
    }

    private async reusableSearch(
        session: SessionState,
        args: SearchArgs,
        scope: Scope,
        config: Config,
    ): Promise<CacheEntry | undefined> {
        let identity;

        try {
            identity = searchIdentity(args, config);
        } catch {
            return undefined;
        }

        const key = keyOf(session.conversationId, [
            "s",
            scope.requester,
            scope.cwd,
            identity.path,
            identity.mode,
            identity.query,
            identity.budget,
        ]);
        const entry = session.cache.get(key);

        if (
            entry === undefined ||
            !stillCurrent(session, entry) ||
            entry.origin.kind !== "search"
        ) {
            this.drop(session, key);

            return undefined;
        }

        try {
            await verifySearchSnapshot(this.host, config, scope, entry.origin.snapshot);
        } catch (error) {
            if (this.fatal(error)) {
                throw error;
            }

            this.drop(session, key);

            return undefined;
        }

        if (!stillCurrent(session, entry)) {
            this.drop(session, key);

            return undefined;
        }

        return entry;
    }

    private replayRead(
        entry: CacheEntry,
        session: SessionState,
        scope: Scope,
        args: ReadArgs,
        created?: Set<string>,
    ): Page | undefined {
        if (
            entry.origin.kind !== "read" ||
            !stillCurrent(session, entry) ||
            entry.origin.snapshot.cwdStat.dev !== scope.cwdStat.dev ||
            entry.origin.snapshot.cwdStat.ino !== scope.cwdStat.ino
        ) {
            return undefined;
        }

        const origin: ReadOrigin = entry.origin;
        const snapshot = {
            ...origin.snapshot,
            cursor: origin.start,
            endLine: origin.snapshot.endLine,
        };
        const handle = this.store.create(snapshot, estimateSnapshotBytes(snapshot));

        if (handle === undefined) {
            return undefined;
        }

        const budget = origin.budget;
        const text = readReuseHit(
            this.host,
            origin.snapshot.path,
            origin.snapshot.ref,
            handle,
            origin.start.line,
            origin.snapshot.endLine,
            budget,
        );

        if (text === undefined) {
            this.store.delete(handle);

            return undefined;
        }

        if (byteLength(text) + 64 >= entry.originalBytes) {
            this.store.delete(handle);

            return undefined;
        }

        created?.add(handle);

        return { text, handle, done: true, reused: true };
    }

    private replaySearch(
        entry: CacheEntry,
        session: SessionState,
        scope: Scope,
        args: SearchArgs,
        created?: Set<string>,
    ): Page | undefined {
        if (
            entry.origin.kind !== "search" ||
            !stillCurrent(session, entry) ||
            entry.origin.snapshot.cwdStat.dev !== scope.cwdStat.dev ||
            entry.origin.snapshot.cwdStat.ino !== scope.cwdStat.ino
        ) {
            return undefined;
        }

        const origin: SearchOrigin = entry.origin;
        const snapshot = { ...origin.snapshot, next: 0 };
        const handle = this.store.create(snapshot, estimateSnapshotBytes(snapshot));

        if (handle === undefined) {
            return undefined;
        }

        const text = searchReuseHit(
            this.host,
            origin.snapshot.path,
            origin.snapshot.mode,
            origin.snapshot.query,
            origin.snapshot.items.length,
            handle,
            origin.budget,
        );

        if (text === undefined) {
            this.store.delete(handle);

            return undefined;
        }

        if (byteLength(text) + 64 >= entry.originalBytes) {
            this.store.delete(handle);

            return undefined;
        }

        created?.add(handle);

        return { text, handle, done: true, reused: true };
    }

    private remember(
        session: SessionState,
        args: ReadArgs | SearchArgs,
        origin: ReuseOrigin,
        text: string,
        config: Config,
    ): void {
        if (!this.enabled) {
            return;
        }

        let identity;

        try {
            identity =
                origin.kind === "read"
                    ? readIdentity(args as ReadArgs, config)
                    : searchIdentity(args as SearchArgs, config);
        } catch {
            return;
        }

        const lookupKey =
            origin.kind === "read"
                ? keyOf(session.conversationId, [
                      "r",
                      origin.snapshot.requester,
                      origin.snapshot.cwd,
                      identity.path,
                      (identity as ReadIdentity).offset,
                      (identity as ReadIdentity).limit,
                      identity.budget,
                  ])
                : keyOf(session.conversationId, [
                      "s",
                      origin.snapshot.requester,
                      origin.snapshot.cwd,
                      identity.path,
                      (identity as SearchIdentity).mode,
                      (identity as SearchIdentity).query,
                      identity.budget,
                  ]);
        const bytes = estimateSnapshotBytes(origin.snapshot);
        const maxEntries = config.layer.maxEntries;
        const maxBytes = config.layer.maxBytes;

        if (bytes > maxBytes || maxEntries < 1) {
            session.stats.bypasses++;

            return;
        }

        const existing = session.cache.get(lookupKey);

        if (existing !== undefined) {
            session.cache.delete(lookupKey);
            session.cacheBytes -= existing.bytes;
        }

        while (session.cache.size >= maxEntries || session.cacheBytes + bytes > maxBytes) {
            const oldest = session.cache.keys().next().value;

            if (oldest === undefined) {
                break;
            }

            this.drop(session, oldest);
        }

        const entry: CacheEntry = {
            key: lookupKey,
            origin,
            epoch: session.epoch,
            ref: origin.kind === "read" ? origin.snapshot.ref : `search:${origin.snapshot.path}`,
            bytes,
            originalBytes: byteLength(text),
            at: Date.now(),
        };

        session.cache.set(lookupKey, entry);
        session.cacheBytes += bytes;
    }

    private touch(session: SessionState, entry: CacheEntry): void {
        session.cache.delete(entry.key);
        session.cache.set(entry.key, entry);
    }

    private drop(session: SessionState, key: string): void {
        const found = session.cache.get(key);

        if (found !== undefined) {
            session.cache.delete(key);
            session.cacheBytes -= found.bytes;
        }
    }

    dispose(): void {
        this.sessions.clear();
        this.uncovered.clear();
    }

    /** Cancellation, timeout, and disposal are not a cache miss; they belong to the caller. */
    private fatal(error: unknown): boolean {
        return (
            error instanceof OpsError &&
            (error.code === "timeout" ||
                error.code === "cancelled" ||
                error.code === "disposed" ||
                error.code === "identity")
        );
    }
}

/** The error text the layer may show for a failed lookup; kept for parity with the tool error pages. */
export function layerError(error: unknown): string {
    return safeErrorMessage(error);
}
