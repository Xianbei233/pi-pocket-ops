/** Replay of an earlier built-in `read` result as a bounded, historical, file-bound text page. */

import type { Config, OpsHost, Page, Scope } from "./types.ts";
import { effectiveBudget } from "./budget.ts";
import { handleMiss, type Entry, type HandleStore, type TextSnapshot } from "./handles.ts";
import { statRegular } from "./fs-safe.ts";
import { sameStat } from "./paths.ts";
import { assertRequester, verifyScope } from "./scope.ts";
import {
    type Attr,
    byteLength,
    envelope,
    minimalError,
    NOTE_REPLAY,
    shortEnvelope,
    utf8Prefix,
} from "./render.ts";

const MIN_ROOM = 4;

function budgetError(host: OpsHost, budget: number): string {
    const message = "ops: replay budget is too small for the next character; raise maxBytes";

    return byteLength(
        shortEnvelope(
            host,
            "ops_result",
            [
                ["e", 1],
                ["code", "budget"],
            ],
            message,
        ),
    ) <= budget
        ? shortEnvelope(
              host,
              "ops_result",
              [
                  ["e", 1],
                  ["code", "budget"],
              ],
              message,
          )
        : minimalError(host, "ops_result", message, budget);
}

interface Chunk {
    readonly text: string;
    readonly next: number;
    readonly done: boolean;
    readonly error?: true;
}

/** Build one fenced page. It always makes progress or returns an explicit budget error. */
function chunkText(
    host: OpsHost,
    snapshot: TextSnapshot,
    offset: number,
    budget: number,
    handle: string,
): Chunk {
    const buffer = Buffer.from(snapshot.text, "utf8");
    const total = buffer.length;
    const start = Math.min(Math.max(0, offset), total);
    const rest = buffer.subarray(start).toString("utf8");

    if (rest === "") {
        return {
            text: envelope(
                host,
                "ops_result",
                [
                    ["replay", 1],
                    ["offset", total],
                    ["done", true],
                ],
                "",
                NOTE_REPLAY,
            ),
            next: total,
            done: true,
        };
    }

    const attrs = (done: boolean): Attr[] => [
        ["replay", 1],
        ["offset", start],
        ["done", done],
        ["handle", done ? undefined : handle],
    ];
    const overhead = byteLength(envelope(host, "ops_result", attrs(false), "", NOTE_REPLAY));
    let room = budget - overhead - 16;

    if (room < MIN_ROOM) {
        return { text: budgetError(host, budget), next: start, done: false, error: true };
    }

    for (let attempt = 0; attempt < 8; attempt++) {
        const piece = utf8Prefix(rest, room);

        if (piece === "") {
            room = Math.floor(room / 2);

            continue;
        }

        const next = start + byteLength(piece);
        const done = next >= total;
        const text = envelope(
            host,
            "ops_result",
            attrs(done),
            host.text.defang(piece),
            NOTE_REPLAY,
        );

        if (byteLength(text) <= budget) {
            return { text, next, done };
        }

        room = Math.floor(room * 0.75);
    }

    return { text: budgetError(host, budget), next: start, done: false, error: true };
}

/** Continue a text snapshot. A changed folder, file identity, requester, or epoch is a handle miss. */
export async function resumeText(
    host: OpsHost,
    config: Config,
    store: HandleStore,
    scope: Scope,
    entry: Entry,
    args: { readonly maxBytes?: number; readonly maxTokens?: number },
    epoch: number,
): Promise<Page> {
    const snapshot = entry.snapshot;

    if (snapshot.kind !== "text") {
        return handleMiss();
    }

    if (
        snapshot.root !== scope.root ||
        snapshot.cwd !== scope.cwd ||
        snapshot.cwdStat.dev !== scope.cwdStat.dev ||
        snapshot.cwdStat.ino !== scope.cwdStat.ino ||
        snapshot.epoch !== epoch
    ) {
        store.delete(entry.handle);

        return handleMiss();
    }

    let stat;

    try {
        stat = await statRegular(scope, snapshot.segments, config.limits.maxFileBytes);
    } catch {
        store.delete(entry.handle);

        return handleMiss();
    }

    if (!sameStat(snapshot.stat, stat)) {
        store.delete(entry.handle);

        return handleMiss();
    }

    await verifyScope(host, scope);
    assertRequester(host, scope);

    const budget = effectiveBudget(args, config.limits.maxOutputBytes);
    const page = chunkText(host, snapshot, snapshot.offset, budget, entry.handle);

    if (page.error === true) {
        return { text: page.text, handle: entry.handle, done: false };
    }

    if (page.done) {
        store.delete(entry.handle);

        return { text: page.text, done: true };
    }

    const next: TextSnapshot = { ...snapshot, offset: page.next };

    if (!store.update(entry.handle, next)) {
        return handleMiss();
    }

    store.touch(entry.handle);

    return { text: page.text, handle: entry.handle, done: false };
}

/** The compact replacement for a byte-identical repeat of a built-in `read`. */
export function builtinReadHit(
    host: OpsHost,
    path: string,
    bytes: number,
    handle: string | undefined,
    example?: string,
): string {
    const label = host.text.quoted(path, 240);

    return (
        `[ops] Identical built-in read of ${label} (${bytes} B); repeated output omitted. ` +
        "The read ran in full; calls/rounds were not merged or reduced, and no provider-cost saving is claimed.\n" +
        (handle === undefined
            ? "For a new read, pass fresh=true to ops_read or turn toolLayer.builtinRead off."
            : `Historical replay: ops_result handle="${handle}" (file identity checked; not a live read). Pass fresh=true to ops_read for a new read.`) +
        (example === undefined
            ? ""
            : `\nExample bounded batch (data only, not executed): ${example}`)
    );
}
