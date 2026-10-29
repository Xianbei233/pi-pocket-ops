/**
 * 0.3.5 bash root integration: B stream capture with injected simple/cd matcher.
 *
 * The root supplies eligibility, trusted-cwd identity, foreign-wrapper trust, and the final page
 * renderer/store. This file owns only the stream-only bash probe: capture api.output, forward it
 * unchanged, and replace the result content only after a complete successful query output.
 */

import {
    matchQueryCommand,
    QueryOutputCapture,
    type QueryCapture,
    type QuerySnapshotIdentity,
    type QuerySnapshotStore,
} from "./query-v034.ts";
import type { QueryMatcher } from "./query-v035.ts";

interface QueryBashApi {
    readonly conversationId: number;
    readonly taskId: string;
    readonly callId: string;
    agent(context: unknown): Promise<{
        readonly cwd?: string;
        readonly extensions?: readonly unknown[];
    }>;
    output(chunk: string | Uint8Array, skipped?: unknown): void;
    diagnostic?(diagnostic: unknown): void;
}

interface QueryBashTool {
    readonly parameters: unknown;
    readonly outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number };
    execute(
        args: { readonly command: string; readonly timeout?: number },
        api: QueryBashApi,
        context: unknown,
    ): Promise<unknown>;
}

interface QueryBashResult {
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
    readonly [key: string]: unknown;
}

export interface QueryBashIntegration {
    readonly enabled: () => boolean;
    readonly budget: () => number;
    readonly store: QuerySnapshotStore;
    readonly identity: (
        api: QueryBashApi,
        context: unknown,
    ) => Promise<QuerySnapshotIdentity | undefined>;
    readonly eligible: (identity: QuerySnapshotIdentity) => boolean;
    readonly trust: (extensions: readonly unknown[]) => boolean;
    readonly render: (
        capture: QueryCapture,
        identity: QuerySnapshotIdentity,
        store: QuerySnapshotStore,
        sourceCallId: string,
    ) => Promise<{ readonly text: string } | undefined>;
    /** Root final check after the real execute: retired/disable/config/cwd/requester/abort/foreign. */
    readonly finalCheck: (
        identity: QuerySnapshotIdentity,
        context: unknown,
    ) => boolean | Promise<boolean>;
    readonly noteUncovered: (conversationId: number, reason: string) => void;
}

function bashShape(parameters: unknown): boolean {
    const schema = parameters as
        { type?: unknown; properties?: unknown; required?: unknown } | undefined;

    return (
        schema?.type === "object" &&
        typeof schema.properties === "object" &&
        schema.properties !== null &&
        Object.hasOwn(schema.properties, "command") &&
        Array.isArray(schema.required) &&
        schema.required.includes("command")
    );
}

function sameIdentity(left: QuerySnapshotIdentity, right: QuerySnapshotIdentity): boolean {
    return (
        left.conversationId === right.conversationId &&
        left.requester === right.requester &&
        left.cwd === right.cwd &&
        left.cwdDev === right.cwdDev &&
        left.cwdIno === right.cwdIno &&
        left.configRevision === right.configRevision
    );
}

/**
 * Root integration wrapper. The original bash execute runs once with the exact original args,
 * cwd, env, Guard, hooks, output, diagnostics, throw, and exit behavior. The proxy only observes
 * and forwards; no command is rewritten or executed again.
 */
export function wrapBashQueryOutput(
    tool: QueryBashTool,
    integration: QueryBashIntegration,
    matcher: QueryMatcher = (command) => matchQueryCommand(command),
    nested = false,
): QueryBashTool {
    return {
        ...tool,
        execute: async (args, api, context) => {
            if (
                !bashShape(tool.parameters) ||
                !integration.enabled() ||
                tool.outputLimits?.maxBytes !== undefined ||
                tool.outputLimits?.maxLines !== undefined
            ) {
                // A custom retained window may already have dropped bytes before our observer
                // can prove completeness. Keep that original window native rather than claim it.
                return tool.execute(args, api, context);
            }

            let identity: QuerySnapshotIdentity | undefined;
            let eligible = false;

            try {
                const agent = await api.agent(context);

                if (agent.cwd !== undefined && integration.trust(agent.extensions ?? [])) {
                    identity = await integration.identity(api, context);

                    eligible =
                        identity !== undefined &&
                        integration.eligible(identity) &&
                        matcher(args.command, identity.cwd) !== undefined;
                }
            } catch {
                eligible = false;
            }

            // Execute outside the eligibility try/catch exactly once. A synchronous original
            // throw (or an unknown wrapper throw) must not be caught and re-executed here.
            if (!eligible || identity === undefined) {
                return tool.execute(args, api, context);
            }

            const capture = new QueryOutputCapture();
            const originalOutput = api.output;
            const originalDiagnostic = api.diagnostic;
            const proxy: QueryBashApi = {
                ...api,
                output: (chunk, skipped) => {
                    try {
                        capture.output(chunk, skipped);
                    } catch {
                        capture.invalidate("chunk");
                    }

                    // Never let the observer replace the command's original output path.
                    originalOutput.call(api, chunk, skipped);
                },
                diagnostic: (diagnostic) => {
                    try {
                        capture.diagnostic(diagnostic);
                    } catch {
                        capture.invalidate("diagnostic");
                    }

                    originalDiagnostic?.call(api, diagnostic);
                },
            };

            const result = (await tool.execute(args, proxy, context)) as QueryBashResult;

            if (result.isError === true || result.content !== undefined) {
                return result;
            }

            try {
                const signal = (context as { readonly abortSignal?: AbortSignal }).abortSignal;

                if (signal?.aborted) {
                    integration.noteUncovered(
                        api.conversationId,
                        "bash query was aborted; native result kept",
                    );

                    return result;
                }

                const finalAgent = await api.agent(context);
                const finalIdentity = await integration.identity(api, context);

                if (
                    finalIdentity === undefined ||
                    !sameIdentity(identity, finalIdentity) ||
                    !integration.eligible(finalIdentity) ||
                    !integration.trust(finalAgent.extensions ?? []) ||
                    !(await integration.finalCheck(identity, context))
                ) {
                    integration.noteUncovered(
                        api.conversationId,
                        "bash query eligibility changed before render; native result kept",
                    );

                    return result;
                }
            } catch {
                integration.noteUncovered(
                    api.conversationId,
                    "bash query final eligibility could not be verified; native result kept",
                );

                return result;
            }

            const captured = capture.finish();

            if (nested && !captured.nestedSafe) {
                integration.noteUncovered(
                    api.conversationId,
                    "nested codemode output has BOM/mixed decoder/source-boundary ambiguity; native result kept",
                );

                return result;
            }

            if (!captured.complete) {
                integration.noteUncovered(
                    api.conversationId,
                    "bash query output was incomplete or host-truncated; native result kept",
                );

                return result;
            }

            if (captured.bytes <= integration.budget()) {
                return result;
            }

            try {
                const page = await integration.render(
                    captured,
                    identity,
                    integration.store,
                    api.callId,
                );

                if (page === undefined) {
                    integration.noteUncovered(
                        api.conversationId,
                        "bash query page could not be stored; native result kept",
                    );

                    return result;
                }

                try {
                    const finalAgent = await api.agent(context);
                    const finalIdentity = await integration.identity(api, context);

                    if (
                        finalIdentity === undefined ||
                        !sameIdentity(identity, finalIdentity) ||
                        !integration.trust(finalAgent.extensions ?? []) ||
                        !(await integration.finalCheck(identity, context))
                    ) {
                        integration.store.deleteScope(identity);
                        integration.noteUncovered(
                            api.conversationId,
                            "bash query eligibility changed after render; page discarded",
                        );

                        return result;
                    }
                } catch {
                    integration.store.deleteScope(identity);
                    integration.noteUncovered(
                        api.conversationId,
                        "bash query final render check failed; page discarded",
                    );

                    return result;
                }

                return { ...result, content: [{ type: "text", text: page.text }] };
            } catch {
                integration.noteUncovered(
                    api.conversationId,
                    "bash query page failed; native result kept",
                );

                return result;
            }
        },
    };
}
