/**
 * Bounded, fail-closed filesystem access.
 *
 * Every path is walked from the trusted cwd with O_NOFOLLOW on each component. The opened object is verified through
 * Linux /proc/self/fd, so a directory swap cannot redirect an open. Regular files must have one link and a stable
 * size; read pages additionally carry a SHA-256 of the bytes that were read.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { BigIntStats, Dir, Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fail, OpsError, throwIfAborted } from "./errors.ts";
import { hasUnsafeChars, isInside, sameStat, statKey } from "./paths.ts";
import type { StatKey } from "./types.ts";
import type { Scope } from "./types.ts";

const FD_ROOT = "/proc/self/fd";
const CHUNK = 64 * 1024;

export function assertPlatform(): void {
    if (process.platform !== "linux") {
        fail(
            "platform",
            "ops: this module needs Linux /proc/self/fd verification; file IO is disabled here",
        );
    }

    if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
        fail(
            "platform",
            "ops: this platform lacks the no-follow open flags; file IO is disabled here",
        );
    }
}

function fdPath(fd: number): string {
    return `${FD_ROOT}/${fd}`;
}

function mapFsError(error: unknown): never {
    if (error instanceof OpsError) {
        throw error;
    }

    const code = (error as NodeJS.ErrnoException | undefined)?.code;

    if (
        code === "ENOENT" ||
        code === "EACCES" ||
        code === "ELOOP" ||
        code === "ENOTDIR" ||
        code === "EISDIR"
    ) {
        fail("unavailable", "ops: path is unavailable");
    }

    if (code === "EMFILE" || code === "ENFILE") {
        fail("busy", "ops: too many open files; retry later");
    }

    fail("io", "ops: file operation failed safely");
}

async function verifyFd(handle: FileHandle, expected: string, root: string): Promise<void> {
    let actual;

    try {
        actual = await realpath(fdPath(handle.fd));
    } catch {
        fail("path", "ops: invalid path: cannot verify the open object");
    }

    if (actual !== expected) {
        fail("path", "ops: invalid path: the open object is not the expected path");
    }

    if (!isInside(actual, root)) {
        fail("path", "ops: invalid path: the open object is outside the allowed root");
    }
}

/** Open a directory below cwd, rejecting every symlink component and verifying the final object. */
async function openDirectory(scope: Scope, segments: readonly string[]): Promise<FileHandle> {
    assertPlatform();

    let current: FileHandle | undefined;

    try {
        current = await open(
            scope.cwd,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
        );
        await verifyFd(current, scope.cwd, scope.root);
    } catch (error) {
        await current?.close().catch(() => {});
        mapFsError(error);
    }

    current = current!;

    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        const expected = join(scope.cwd, ...segments.slice(0, index + 1));
        let next: FileHandle | undefined;

        try {
            next = await open(
                `${fdPath(current.fd)}/${segment}`,
                constants.O_RDONLY |
                    constants.O_DIRECTORY |
                    constants.O_NOFOLLOW |
                    constants.O_NONBLOCK,
            );
            await verifyFd(next, expected, scope.root);
        } catch (error) {
            await next?.close().catch(() => {});
            await current.close().catch(() => {});
            mapFsError(error);
        }

        await current.close().catch(() => {});
        current = next!;
    }

    return current;
}

/** Open a regular file below cwd with no symlink of any kind and exactly one hard link. */
async function openRegular(
    scope: Scope,
    segments: readonly string[],
    maxBytes: number,
): Promise<{
    readonly handle: FileHandle;
    readonly stat: StatKey;
    readonly path: string;
}> {
    if (segments.length === 0) {
        fail("path", "ops: not a file");
    }

    const parent = await openDirectory(scope, segments.slice(0, -1));
    const name = segments.at(-1)!;
    const expected = join(scope.cwd, ...segments);
    let handle: FileHandle | undefined;

    try {
        handle = await open(
            `${fdPath(parent.fd)}/${name}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = await handle.stat({ bigint: true });

        if (!info.isFile()) {
            fail("path", "ops: invalid path: not a regular file");
        }

        if (info.nlink > 1n) {
            fail("path", "ops: invalid path: hard-linked files are not read");
        }

        if (info.size > BigInt(maxBytes)) {
            fail("too-large", "ops: file is larger than the configured limit");
        }

        await verifyFd(handle, expected, scope.root);

        return { handle, stat: statKey(info), path: expected };
    } catch (error) {
        await handle?.close().catch(() => {});
        mapFsError(error);
    } finally {
        await parent.close().catch(() => {});
    }
}

/** Read one bounded file and return its bytes, after-stat, and SHA-256. */
export async function readRegular(
    scope: Scope,
    segments: readonly string[],
    maxBytes: number,
    signal: AbortSignal | undefined,
    onBytes?: (bytes: number) => void,
): Promise<{
    readonly buffer: Buffer;
    readonly stat: StatKey;
    readonly path: string;
    readonly hash: string;
}> {
    throwIfAborted(signal);

    const opened = await openRegular(scope, segments, maxBytes);

    try {
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        const target = Math.min(maxBytes, opened.stat.size);
        let total = 0;

        while (total < target) {
            throwIfAborted(signal);

            const wanted = Math.min(CHUNK, target - total);
            const buffer = Buffer.allocUnsafe(wanted);
            const { bytesRead } = await opened.handle.read(buffer, 0, wanted, null);

            if (bytesRead === 0) {
                break;
            }

            total += bytesRead;
            onBytes?.(bytesRead);

            if (total > target) {
                fail("too-large", "ops: file read exceeded the configured limit");
            }

            const chunk = buffer.subarray(0, bytesRead);

            hash.update(chunk);
            chunks.push(Buffer.from(chunk));
        }

        const after = await opened.handle.stat({ bigint: true });
        const afterKey = statKey(after);

        if (
            afterKey.dev !== opened.stat.dev ||
            afterKey.ino !== opened.stat.ino ||
            afterKey.size !== opened.stat.size ||
            afterKey.mtimeNs !== opened.stat.mtimeNs ||
            afterKey.ctimeNs !== opened.stat.ctimeNs ||
            afterKey.nlink !== opened.stat.nlink ||
            BigInt(total) !== after.size
        ) {
            fail("changed", "ops: file changed while it was read; call again");
        }

        // The fd still points at the object we verified; confirm both the fd path and a fresh walk of the path.
        await verifyFd(opened.handle, opened.path, scope.root);
        const current = await statRegular(scope, segments, maxBytes);

        if (!sameStat(afterKey, current)) {
            fail("changed", "ops: file path changed while it was read; call again");
        }

        return {
            buffer: Buffer.concat(chunks, total),
            stat: afterKey,
            path: opened.path,
            hash: hash.digest("hex"),
        };
    } catch (error) {
        mapFsError(error);
    } finally {
        await opened.handle.close().catch(() => {});
    }
}

/** Stat one regular file without reading its content. */
export async function statRegular(
    scope: Scope,
    segments: readonly string[],
    maxBytes: number,
): Promise<StatKey> {
    const opened = await openRegular(scope, segments, maxBytes);

    try {
        return opened.stat;
    } finally {
        await opened.handle.close().catch(() => {});
    }
}

/** Stat one directory without listing it. */
export async function statDirectory(scope: Scope, segments: readonly string[]): Promise<StatKey> {
    const handle = await openDirectory(scope, segments);

    try {
        return statKey(await handle.stat({ bigint: true }));
    } finally {
        await handle.close().catch(() => {});
    }
}

/** An open directory: the verified handle, its iterator, and its canonical path. */
export interface OpenDirectory {
    readonly handle: FileHandle;
    readonly iterator: Dir;
    readonly path: string;
}

/** Open a directory for bounded iteration. The iterator reads through the verified fd, not a fresh path walk. */
export async function openDirectoryForScan(
    scope: Scope,
    segments: readonly string[],
): Promise<OpenDirectory> {
    const handle = await openDirectory(scope, segments);
    const path = join(scope.cwd, ...segments);

    try {
        const iterator = await opendir(fdPath(handle.fd));

        return { handle, iterator, path };
    } catch (error) {
        await handle.close().catch(() => {});
        mapFsError(error);
    }
}

/** Collect at most `limit` entries from the iterator; `more` says the directory had at least one more. */
export async function collectEntries(
    dir: OpenDirectory,
    limit: number,
    signal: AbortSignal | undefined,
): Promise<{ readonly entries: readonly Dirent[]; readonly more: boolean }> {
    if (limit <= 0) {
        await dir.iterator.close().catch(() => {});

        return { entries: [], more: true };
    }

    const entries: Dirent[] = [];
    let more = false;

    try {
        for await (const entry of dir.iterator) {
            throwIfAborted(signal);

            if (entries.length >= limit) {
                more = true;
                break;
            }

            entries.push(entry);
        }
    } finally {
        await dir.iterator.close().catch(() => {});
    }

    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    return { entries, more };
}

/** lstat a child through an already verified directory fd; the final component is not followed. */
export async function childStat(dir: OpenDirectory, name: string): Promise<BigIntStats> {
    try {
        return await lstat(`${fdPath(dir.handle.fd)}/${name}`, { bigint: true });
    } catch (error) {
        mapFsError(error);
    }
}

/** Open a child directory through an already verified directory fd. */
export async function openChildDirectory(
    scope: Scope,
    parent: OpenDirectory,
    name: string,
): Promise<OpenDirectory> {
    const expected = join(parent.path, name);
    let handle: FileHandle | undefined;

    try {
        handle = await open(
            `${fdPath(parent.handle.fd)}/${name}`,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
        );
        await verifyFd(handle, expected, scope.root);
        const iterator = await opendir(fdPath(handle.fd));

        return { handle, iterator, path: expected };
    } catch (error) {
        await handle?.close().catch(() => {});
        mapFsError(error);
    }
}

/** Open and read a child regular file through an already verified directory fd. */
export async function readChildRegular(
    scope: Scope,
    parent: OpenDirectory,
    name: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    onBytes?: (bytes: number) => void,
): Promise<{ readonly buffer: Buffer; readonly stat: StatKey; readonly hash: string }> {
    throwIfAborted(signal);

    const expected = join(parent.path, name);
    let handle: FileHandle | undefined;

    try {
        handle = await open(
            `${fdPath(parent.handle.fd)}/${name}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = await handle.stat({ bigint: true });

        if (!info.isFile() || info.nlink > 1n) {
            fail("path", "ops: invalid path: not a readable regular file");
        }

        if (info.size > BigInt(maxBytes)) {
            fail("too-large", "ops: file is larger than the configured scan limit");
        }

        await verifyFd(handle, expected, scope.root);

        const before = statKey(info);
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        const target = Math.min(maxBytes, before.size);
        let total = 0;

        while (total < target) {
            throwIfAborted(signal);

            const wanted = Math.min(CHUNK, target - total);
            const buffer = Buffer.allocUnsafe(wanted);
            const { bytesRead } = await handle.read(buffer, 0, wanted, null);

            if (bytesRead === 0) {
                break;
            }

            total += bytesRead;
            onBytes?.(bytesRead);

            if (total > target) {
                fail("too-large", "ops: file read exceeded the configured scan limit");
            }

            const chunk = buffer.subarray(0, bytesRead);

            hash.update(chunk);
            chunks.push(Buffer.from(chunk));
        }

        const after = statKey(await handle.stat({ bigint: true }));

        if (
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs ||
            after.ctimeNs !== before.ctimeNs ||
            BigInt(total) !== BigInt(after.size)
        ) {
            fail("changed", "ops: file changed while it was read; call again");
        }

        await verifyFd(handle, expected, scope.root);
        await verifyFd(parent.handle, parent.path, scope.root);
        const current = statKey(await childStat(parent, name));

        if (!sameStat(after, current)) {
            fail("changed", "ops: file path changed while it was read; call again");
        }

        return { buffer: Buffer.concat(chunks, total), stat: after, hash: hash.digest("hex") };
    } catch (error) {
        mapFsError(error);
    } finally {
        await handle?.close().catch(() => {});
    }

    return fail("io", "ops: file operation failed safely");
}

/** Identity of a directory path; a replacement object gets a different dev/ino. */
export async function directoryIdentity(path: string): Promise<StatKey> {
    try {
        const info = await lstat(path, { bigint: true });

        if (!info.isDirectory() || info.isSymbolicLink()) {
            fail("cwd", "ops: session folder is not a real directory");
        }

        return statKey(info);
    } catch (error) {
        if (error instanceof OpsError) {
            throw error;
        }

        fail("cwd", "ops: session folder is unavailable");
    }
}

/** Resolve and validate the session cwd. It must be a real, canonical, absolute directory. */
export async function canonicalCwd(raw: string | undefined): Promise<string> {
    if (typeof raw !== "string" || raw.length === 0) {
        fail("cwd", "ops: session folder is unavailable");
    }

    const normalized = raw.endsWith("/") && raw !== "/" ? raw.slice(0, -1) : raw;

    if (!normalized.startsWith("/") || hasUnsafeChars(normalized) || normalized.includes("\\")) {
        fail("cwd", "ops: session folder is not a canonical absolute path");
    }

    let canonical;

    try {
        canonical = await realpath(normalized);
    } catch {
        fail("cwd", "ops: session folder is unavailable");
    }

    if (canonical !== normalized) {
        fail("cwd", "ops: session folder must not contain a symbolic link");
    }

    let info;

    try {
        info = await lstat(normalized);
    } catch {
        fail("cwd", "ops: session folder is unavailable");
    }

    if (!info.isDirectory() || info.isSymbolicLink()) {
        fail("cwd", "ops: session folder is not a real directory");
    }

    return canonical;
}
