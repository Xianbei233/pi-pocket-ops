/** Owner configuration: PI_POCKET_OPS_CONFIG is read once per module version and validated against hard caps. */

import { homedir } from "node:os";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hasUnsafeChars, isExcludedName, isInside } from "./paths.ts";
import type { Config, ConfigState, DedupMode, LayerConfig, Limits, OpsHost } from "./types.ts";

/** Hard caps, independent of owner configuration. */
export const HARD = {
    maxOutputBytes: 262_144,
    maxBatchOutputBytes: 262_144,
    maxFileBytes: 16_777_216,
    maxScanEntries: 20_000,
    maxScanBytes: 67_108_864,
    maxDepth: 16,
    timeoutMs: 30_000,
    batchTimeoutMs: 60_000,
    maxBatchOps: 8,
    batchConcurrency: 8,
    batchItemTimeoutMs: 30_000,
    maxMatches: 1_000,
    handleTtlMs: 3_600_000,
    maxHandles: 256,
    maxHandlesPerScope: 32,
    maxHandleBytes: 16_777_216,
} as const;

/** The smallest whole-return budget this module renders on purpose. */
export const MIN_BUDGET = 256;

const DEFAULT_LAYER: LayerConfig = {
    enabled: true,
    dedup: "off",
    builtinRead: "soft",
    builtinReadMinBytes: 512,
    builtinReadMinSavingsBytes: 64,
    maxEntries: 32,
    maxBytes: 1_048_576,
    maxSessions: 64,
    sessionTtlMs: 900_000,
};

const DEDUP_MODES: readonly DedupMode[] = ["off", "audit", "soft"];

function readLayer(raw: unknown): LayerConfig {
    if (raw === undefined) {
        return { ...DEFAULT_LAYER };
    }

    if (!isRecord(raw)) {
        throw new Error("toolLayer must be an object");
    }

    for (const key of Object.keys(raw)) {
        if (
            key !== "enabled" &&
            key !== "dedup" &&
            key !== "builtinRead" &&
            key !== "builtinReadMinBytes" &&
            key !== "builtinReadMinSavingsBytes" &&
            key !== "maxEntries" &&
            key !== "maxBytes" &&
            key !== "maxSessions" &&
            key !== "sessionTtlMs"
        ) {
            throw new Error("unknown toolLayer key");
        }
    }

    let layer: LayerConfig = { ...DEFAULT_LAYER };

    if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== "boolean") {
            throw new Error("toolLayer.enabled must be a boolean");
        }

        layer = { ...layer, enabled: raw.enabled };
    }

    for (const key of ["dedup", "builtinRead"] as const) {
        const value = raw[key];

        if (value !== undefined) {
            if (typeof value !== "string" || !DEDUP_MODES.includes(value as DedupMode)) {
                throw new Error(`toolLayer.${key} must be off, audit, or soft`);
            }

            layer = { ...layer, [key]: value as DedupMode };
        }
    }

    if (raw.builtinReadMinBytes !== undefined) {
        const value = raw.builtinReadMinBytes;

        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 1 ||
            value > 1_048_576
        ) {
            throw new Error(
                "toolLayer.builtinReadMinBytes must be an integer between 1 and 1048576",
            );
        }

        layer = { ...layer, builtinReadMinBytes: value };
    }

    for (const key of [
        "builtinReadMinSavingsBytes",
        "maxEntries",
        "maxBytes",
        "maxSessions",
    ] as const) {
        const value = raw[key];

        if (value === undefined) {
            continue;
        }

        const [min, max] =
            key === "maxEntries"
                ? [1, 128]
                : key === "maxSessions"
                  ? [1, 1_024]
                  : key === "builtinReadMinSavingsBytes"
                    ? [0, 65_536]
                    : [65_536, 16_777_216];

        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < min ||
            value > max
        ) {
            throw new Error(`toolLayer.${key} must be an integer between ${min} and ${max}`);
        }

        layer = { ...layer, [key]: value };
    }

    if (raw.sessionTtlMs !== undefined) {
        const value = raw.sessionTtlMs;

        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < 60_000 ||
            value > 3_600_000
        ) {
            throw new Error("toolLayer.sessionTtlMs must be between 60000 and 3600000");
        }

        layer = { ...layer, sessionTtlMs: value };
    }

    return layer;
}

const DEFAULT_LIMITS: Limits = {
    maxOutputBytes: 32_768,
    maxBatchOutputBytes: 65_536,
    maxFileBytes: 4_194_304,
    maxSearchFileBytes: 1_048_576,
    maxScanEntries: 2_000,
    maxScanBytes: 8_388_608,
    maxDepth: 8,
    timeoutMs: 5_000,
    batchTimeoutMs: 15_000,
    maxBatchOps: 8,
    batchConcurrency: 1,
    batchItemTimeoutMs: 5_000,
    maxMatches: 200,
    maxMatchLineBytes: 400,
    handleTtlMs: 300_000,
    maxHandles: 64,
    maxHandlesPerScope: 16,
    maxHandleBytes: 4_194_304,
};

const RANGES: Record<keyof Limits, readonly [number, number]> = {
    maxOutputBytes: [MIN_BUDGET, HARD.maxOutputBytes],
    maxBatchOutputBytes: [MIN_BUDGET, HARD.maxBatchOutputBytes],
    maxFileBytes: [1_024, HARD.maxFileBytes],
    maxSearchFileBytes: [1, HARD.maxFileBytes],
    maxScanEntries: [1, HARD.maxScanEntries],
    maxScanBytes: [1, HARD.maxScanBytes],
    maxDepth: [0, HARD.maxDepth],
    timeoutMs: [100, HARD.timeoutMs],
    batchTimeoutMs: [100, HARD.batchTimeoutMs],
    maxBatchOps: [1, HARD.maxBatchOps],
    batchConcurrency: [1, HARD.batchConcurrency],
    batchItemTimeoutMs: [100, HARD.batchItemTimeoutMs],
    maxMatches: [1, HARD.maxMatches],
    maxMatchLineBytes: [64, 4_096],
    handleTtlMs: [1_000, HARD.handleTtlMs],
    maxHandles: [1, HARD.maxHandles],
    maxHandlesPerScope: [1, HARD.maxHandlesPerScope],
    maxHandleBytes: [65_536, HARD.maxHandleBytes],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFailure(reason: string): ConfigState {
    return { ok: false, reason: `ops: configuration denied: ${reason}. File IO is disabled.` };
}

function readLimits(raw: unknown): Limits {
    if (raw === undefined) {
        return { ...DEFAULT_LIMITS };
    }

    if (!isRecord(raw)) {
        throw new Error("limits must be an object");
    }

    for (const key of Object.keys(raw)) {
        if (!(key in DEFAULT_LIMITS)) {
            throw new Error("unknown limits key");
        }
    }

    const limits: Limits = { ...DEFAULT_LIMITS };

    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
        const value = raw[key];

        if (value === undefined) {
            continue;
        }

        const [min, max] = RANGES[key];

        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value < min ||
            value > max
        ) {
            throw new Error(`limits.${key} must be an integer between ${min} and ${max}`);
        }

        limits[key] = value;
    }

    if (limits.maxSearchFileBytes > limits.maxFileBytes) {
        throw new Error("limits.maxSearchFileBytes must not exceed limits.maxFileBytes");
    }

    if (limits.maxHandlesPerScope > limits.maxHandles) {
        throw new Error("limits.maxHandlesPerScope must not exceed limits.maxHandles");
    }

    return limits;
}

function protectedPaths(home: string, dataDir: string, agentDir: string): string[] {
    return [
        dataDir,
        agentDir,
        join(home, ".ssh"),
        join(home, ".gnupg"),
        join(home, ".aws"),
        join(home, ".azure"),
        join(home, ".kube"),
        join(home, ".docker"),
        join(home, ".password-store"),
        join(home, ".config", "gh"),
        join(home, ".config", "gcloud"),
        join(home, ".config", "op"),
        join(home, ".config", "sops"),
        join(home, ".config", "age"),
        "/etc",
        "/proc",
        "/sys",
        "/dev",
        "/root",
        "/boot",
        "/run",
        "/var/lib",
        "/var/run",
    ];
}

/** Reject roots that are the home folder, an ancestor of it, host data, credentials, or system internals. */
function rootIsProtected(root: string, home: string, protectedList: readonly string[]): boolean {
    if (root === home || isInside(home, root)) {
        return true;
    }

    return protectedList.some((path) => isInside(root, path) || isInside(path, root));
}

async function validateRoot(
    raw: unknown,
    index: number,
    home: string,
    protectedList: readonly string[],
): Promise<string> {
    const label = `allowedRoots[${index}]`;

    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) {
        throw new Error(`${label} must be a non-empty path string`);
    }

    if (raw !== raw.trim()) {
        throw new Error(`${label} has leading or trailing whitespace`);
    }

    if (hasUnsafeChars(raw) || raw.includes("\\")) {
        throw new Error(`${label} has an unsafe character`);
    }

    if (!isAbsolute(raw) || resolve(raw) !== raw) {
        throw new Error(`${label} must be an absolute, normalized path`);
    }

    if (raw === "/") {
        throw new Error(`${label} must not be the filesystem root`);
    }

    const segments = raw.split("/").filter((segment) => segment !== "");

    if (segments.some((segment) => isExcludedName(segment))) {
        throw new Error(
            `${label} is in or contains a hidden, credential, or policy-excluded folder`,
        );
    }

    if (rootIsProtected(raw, home, protectedList)) {
        throw new Error(`${label} is a protected folder`);
    }

    let info;

    try {
        info = await lstat(raw);
    } catch {
        throw new Error(`${label} does not exist`);
    }

    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`${label} must be an existing real directory`);
    }

    let canonical;

    try {
        canonical = await realpath(raw);
    } catch {
        throw new Error(`${label} cannot be resolved`);
    }

    if (canonical !== raw) {
        throw new Error(`${label} must not contain a symbolic link`);
    }

    const again = await stat(raw);

    if (!again.isDirectory()) {
        throw new Error(`${label} must be a directory`);
    }

    return canonical;
}

/** Read and validate the owner's JSON configuration. */
export async function loadConfig(
    host: OpsHost,
    raw: string | undefined = process.env.PI_POCKET_OPS_CONFIG,
): Promise<ConfigState> {
    if (raw === undefined || raw.trim() === "") {
        return configFailure("PI_POCKET_OPS_CONFIG is not set");
    }

    if (Buffer.byteLength(raw, "utf8") > 65_536) {
        return configFailure("PI_POCKET_OPS_CONFIG is larger than 64 KiB");
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return configFailure("PI_POCKET_OPS_CONFIG is not valid JSON");
    }

    if (!isRecord(parsed)) {
        return configFailure("PI_POCKET_OPS_CONFIG must be a JSON object");
    }

    for (const key of Object.keys(parsed)) {
        if (key !== "allowedRoots" && key !== "limits" && key !== "toolLayer") {
            return configFailure("unknown top-level key");
        }
    }

    const allowedRoots = parsed.allowedRoots;

    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || allowedRoots.length > 16) {
        return configFailure("allowedRoots must be a non-empty array of at most 16 paths");
    }

    let limits: Limits;
    let layer: LayerConfig;

    try {
        limits = readLimits(parsed.limits);
        layer = readLayer(parsed.toolLayer);
    } catch (error) {
        return configFailure(error instanceof Error ? error.message : "limits are invalid");
    }

    const home = resolve(homedir());
    const dataDir = resolve(host.dataDir);
    const agentDir = resolve(host.agentDir);
    const protectedList = protectedPaths(home, dataDir, agentDir);
    const roots: string[] = [];

    for (let index = 0; index < allowedRoots.length; index++) {
        try {
            roots.push(await validateRoot(allowedRoots[index], index, home, protectedList));
        } catch (error) {
            return configFailure(
                error instanceof Error ? error.message : `allowedRoots[${index}] is invalid`,
            );
        }
    }

    const config: Config = { roots, limits, layer, home, dataDir, agentDir };

    return { ok: true, config };
}
