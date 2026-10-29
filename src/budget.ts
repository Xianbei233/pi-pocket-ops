/** Whole-return byte budgets. maxTokens is only a ceil(bytes / 4) heuristic, never a provider token count. */

import { fail } from "./errors.ts";
export interface BudgetArgs {
    readonly maxBytes?: number;
    readonly maxTokens?: number;
}

/** Validate and combine a caller's budget with the owner's cap. */
export function effectiveBudget(args: BudgetArgs, cap: number): number {
    let budget = cap;

    if (args.maxBytes !== undefined) {
        if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1) {
            fail("budget", "ops: maxBytes must be a positive integer");
        }

        budget = Math.min(budget, args.maxBytes);
    }

    if (args.maxTokens !== undefined) {
        if (
            !Number.isSafeInteger(args.maxTokens) ||
            args.maxTokens < 1 ||
            args.maxTokens > 100_000_000
        ) {
            fail("budget", "ops: maxTokens must be a positive integer");
        }

        budget = Math.min(budget, args.maxTokens * 4);
    }

    return Math.max(1, Math.min(budget, cap));
}

/** The heuristic token figure shown in headers. */
export function tokenEstimate(bytes: number): number {
    return Math.ceil(bytes / 4);
}
