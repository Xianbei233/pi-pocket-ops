/** Trusted call scope and cancellation plumbing. */

import { relative } from "node:path";
import { canonicalCwd, directoryIdentity } from "./fs-safe.ts";
import { fail, throwIfAborted } from "./errors.ts";
import { isExcludedName, isInside } from "./paths.ts";
import type { HandleStore } from "./handles.ts";
import type { Config, OpsContext, OpsHost, Scope } from "./types.ts";

export interface ScopeInput {
    readonly conversationId: number;
    readonly cwd: string | undefined;
    readonly requester: string | undefined;
    readonly signal: AbortSignal | undefined;
}

/** Find the most specific allowed root that contains cwd, and reject excluded cwd components. */
function chooseRoot(config: Config, cwd: string): string {
    const matches = config.roots
        .filter((root) => isInside(cwd, root))
        .sort((left, right) => right.length - left.length);
    const root = matches[0];

    if (root === undefined) {
        fail("root", "ops: session folder denied: outside the owner-allowed roots");
    }

    const below = relative(root, cwd);

    if (below !== "" && below.split("/").some((segment) => isExcludedName(segment))) {
        fail("root", "ops: session folder denied: policy-excluded location");
    }

    return root;
}

/** Build a scope from the trusted cwd and requester. Neither can be chosen by the model. */
export async function makeScope(host: OpsHost, config: Config, input: ScopeInput): Promise<Scope> {
    if (typeof input.requester !== "string" || input.requester.length === 0) {
        fail("identity", "ops: requester is unavailable; file IO is denied");
    }

    const cwd = await canonicalCwd(input.cwd);
    const cwdStat = await directoryIdentity(cwd);
    const root = chooseRoot(config, cwd);

    return {
        conversationId: input.conversationId,
        conversationKey: String(input.conversationId),
        requester: input.requester,
        cwd,
        root,
        cwdStat,
        signal: input.signal,
    };
}

/** Re-check that the person Pi works for has not changed during an operation. */
export function assertRequester(host: OpsHost, scope: Scope): void {
    const current = host.requesterOf(scope.conversationId);

    if (current !== scope.requester) {
        fail("identity", "ops: requester changed; call again");
    }
}

/** Re-check the folder identity and requester before returning content or storing a handle. */
export async function verifyScope(host: OpsHost, scope: Scope): Promise<void> {
    assertRequester(host, scope);
    throwIfAborted(scope.signal);

    const cwd = await canonicalCwd(scope.cwd);
    const identity = await directoryIdentity(scope.cwd);

    if (
        cwd !== scope.cwd ||
        identity.dev !== scope.cwdStat.dev ||
        identity.ino !== scope.cwdStat.ino ||
        !isInside(cwd, scope.root)
    ) {
        fail("changed", "ops: session folder invalid or changed; call again");
    }

    assertRequester(host, scope);
    throwIfAborted(scope.signal);
}

/** Combine abort signals without leaking listeners. The first abort wins. */
export function combineSignals(signals: readonly (AbortSignal | undefined)[]): {
    readonly signal: AbortSignal;
    readonly cleanup: () => void;
} {
    const controller = new AbortController();
    const listeners: (() => void)[] = [];

    for (const signal of signals) {
        if (signal === undefined) {
            continue;
        }

        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }

        const listener = () => controller.abort(signal.reason);

        signal.addEventListener("abort", listener, { once: true });

        if (signal.aborted) {
            controller.abort(signal.reason);
        }

        listeners.push(() => signal.removeEventListener("abort", listener));
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const remove of listeners) {
                remove();
            }
        },
    };
}

export interface CallControl {
    readonly signal: AbortSignal;
    readonly cleanup: () => void;
}

/** One tool call's lifetime: store disposal, timeout, context cancellation, and the Durable api.signal. */
export function createCallControl(
    store: HandleStore,
    context: OpsContext,
    apiSignal: AbortSignal | undefined,
    timeoutMs: number,
): CallControl {
    const call = new AbortController();
    const untrack = store.track(call);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("ops-timeout"), timeoutMs);

    timer.unref?.();

    const combined = combineSignals([context.abortSignal, apiSignal, call.signal, timeout.signal]);

    return {
        signal: combined.signal,
        cleanup: () => {
            clearTimeout(timer);
            combined.cleanup();
            untrack();
        },
    };
}
