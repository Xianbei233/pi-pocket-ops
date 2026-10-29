/** 0.3.5 C matcher: exact canonical cd prefix around a 0.3.4 simple query. */

import { matchQueryCommand, type QueryMatch } from "./query-v034.ts";

const FORBIDDEN = [
    ";",
    "&",
    "|",
    "<",
    ">",
    "(",
    ")",
    "{",
    "}",
    "`",
    "$",
    "\\",
    "'",
    '"',
    "*",
    "?",
    "[",
    "]",
    "~",
    "!",
    "\n",
    "\r",
    "\0",
];

export type QueryMatcher = (command: string, cwd: string) => QueryMatch | undefined;

/**
 * Strict fixed prefix: `cd <canonical trusted cwd> && <simple query>`.
 * This is output-surface recognition only. The original command still executes exactly once
 * under its original cwd/env/Guard; no split, rewrite, or new execution.
 */
export function matchCdQueryCommand(command: unknown, trustedCwd: string): QueryMatch | undefined {
    if (
        typeof command !== "string" ||
        command.trim() === "" ||
        command.trim() !== command ||
        !command.isWellFormed() ||
        trustedCwd.length === 0 ||
        FORBIDDEN.some((character) => trustedCwd.includes(character)) ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trustedCwd)
    ) {
        return undefined;
    }

    if (
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(command.replaceAll("\t", " ")) ||
        /\p{Zs}/u.test(command.replaceAll("\t", " ").replaceAll(" ", ""))
    ) {
        return undefined;
    }

    const tokens = command.split(/[ \t]+/u);

    if (tokens.length < 4 || tokens[0] !== "cd" || tokens[1] !== trustedCwd || tokens[2] !== "&&") {
        return undefined;
    }

    const matched = matchQueryCommand(tokens.slice(3).join(" "));

    return matched === undefined ? undefined : { ...matched, cwd: trustedCwd };
}

export const matchCdOnly: QueryMatcher = (command, cwd) => matchCdQueryCommand(command, cwd);

export function matchQueryOrCd(command: unknown, trustedCwd: string): QueryMatch | undefined {
    if (typeof command !== "string") {
        return undefined;
    }

    return matchCdQueryCommand(command, trustedCwd) ?? matchQueryCommand(command);
}
