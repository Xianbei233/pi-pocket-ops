# Pi Pocket Ops

**Explicit, bounded batch writes.** `ops_write` and `ops_edit` change 1–8 files in one call. Ops adds no approval step of its own; normal host `beforeTool` hooks and plan mode still run. The native `edit`/`write` tools stay unchanged and are not wrapped, replaced, or made the default path.

`pi-pocket-ops` is a drop-in extension for Pi Pocket 0.18.0. It uses extension API 1 and the legacy `content` result. Pi Pocket 0.19's official documentation records that 0.19 still accepts legacy `content`; 0.19 was not run-verified here, and future versions are not guaranteed. It adds five read-only tools, two explicit write tools, and an owner-only global `/ops-mutations [call-id]` command that reads this conversation's journal. The command reads the durable per-file status for the last 16 batches; it never returns file content.

- `ops_read`: numbered UTF-8 file pages with exact continuation for very long lines.
- `ops_search`: bounded, sorted file listing and literal text search. No regex.
- `ops_check`: a bounded identity check (fingerprint, size, optional SHA-256) with no content.
- `ops_batch`: up to eight read/search/check calls under one output and scan budget, with bounded concurrency.
- `ops_result`: continue a truncated file/query/root page or replay an earlier built-in `read` by its short-lived handle; a root summary handle restarts the full root text at offset 0.
- `ops_write`: write or replace 1–8 complete UTF-8 files in one call; per-file results, best-effort rollback, and no content echoed back.
- `ops_edit`: apply 1–64 exact, non-overlapping replacements per file to 1–8 existing files; any missing/ambiguous match aborts the whole batch with zero writes.

It never runs commands, starts subprocesses, opens the network, installs packages, or evaluates code. Writes happen only through explicit `ops_write`/`ops_edit` calls with bounded, pinned IO; Ops does not request a separate approval or read a host approval queue, and normal `beforeTool`/Guard hooks and plan mode still run first. It is not a filesystem sandbox: it is a bounded, fail-closed path inside the server process.

**Default toolset boundary:** the installed Pocket durable toolset exposes `read`, `write`, `edit`, and `bash`; it has no built-in search/grep/find/ls to wrap. Ops does not invent a default search/check tool and does not force `codemode` or batch; those remain explicit model choices. The built-in `read` and a strict recognized simple-query subset of the original `bash` execute are output-governed; bash is never treated as read-only and its command runs exactly once.

Version 0.2 also adds an optional **session layer**. It wraps the built-in `read` and `ops_read`/`ops_search` at `execute`, after every `beforeTool` hook. The built-in `read` always runs first; a successful plain-text result above the configured output budget is paged with `ops_result` continued by an internal handle, bounded by the original output limits and safe line framing, and only a byte-identical fresh result is replaced by a compact note plus a replay handle. Parameter-call compatibility: the v0.1 parameter shapes still work, and `ops_read`/`ops_search`/`ops_result` default text is largely v0.1. `ops_batch` output is explicitly **v0.2 breaking**: compact `<ops_batch v="2">` items instead of `<ops_item>`. The schema also adds `ops_check`, `fresh`, concurrency, and dependency fields; do not describe all schemas as unchanged. The ops layer never rewrites, merges, or caches bash execution; its strict lexer only classifies a display surface and the original command still runs exactly once. The separate 0.3.0 tool gate wraps the actual bash execute only to count call shape or apply its owner-enabled refusal; it does not inspect shell semantics.

**0.4.1** removes the Ops-side approval request and its durable memo. `ops_write`/`ops_edit` remain explicit, bounded tools; the result reports `approval: { required: false, requests: 0, approved: false }`. Ops does not call an approval queue, read `host.approvals` or `host.guard`, or reuse an old approval memo. Normal `beforeTool`/`afterTool` hooks, including Guard, still run first and can block; plan mode blocks both tools. The tools do not wrap, rename, or take over the native `write`/`edit` tools. Linux-only IO pins every parent with `O_NOFOLLOW`, opens an existing target `O_RDWR` without truncating it, creates a new target only with `O_CREAT|O_EXCL` after validation, rechecks roots/cwd/parent/inode/content before writing, and writes through the bound descriptor. Any failure aborts the batch; an existing file is restored through its bound descriptor only while its bytes still match what this call wrote. A new file created by the call is **kept** rather than unlinked by path, and is reported as `rollback_failed` with `partial: true` unless its bound inode was already unlinked. The per-file result says exactly what was written, restored, or may remain. A durable, bounded journal (`x.pi-pocket-ops.mutations`, conversation scope, last 16 batches, hashes/status only, no content) records the full plan before any filesystem mutation and each file's start/written/rollback state. If journal writing fails, no further file change is allowed. A cancelled or interrupted call is not replayed; inspect `/ops-mutations [call-id]`, not the possibly overridden tool result. A crash can leave a partial batch; there is no automatic crash recovery. Limits reuse the existing owner config: files = `min(8, limits.maxBatchOps)`, request/final/backup totals and each file ≤ `min(1048576, limits.maxFileBytes)`; `limits.batchTimeoutMs` bounds execution. See [docs/OPS-CONFIG.md](docs/OPS-CONFIG.md), [docs/INSTALL.md](docs/INSTALL.md), and [docs/security.md](docs/security.md). **0.4.0** introduced these tools with an Ops-side approval queue and memo; 0.4.1 keeps the IO limits, journal, rollback, and command surface while removing that approval layer.

**0.3.7 + configuration UI `settings.1`** adds the owner-only **Menu → Ops 配置** page (`pi-pocket-ops/index.js` + `style.css`), backed by two owner routes over the same `x.pi-pocket-ops.config` Doc and revision CAS as `/ops-config`. It shows the real package version, source/revision, and the separate module/config-disabled/layer states; it edits `allowedRoots`, `limits`, and `toolLayer` through the original `loadConfig`, with protected roots still refused. No Pi Pocket core edit, no separate server, and no new config store. The runtime package version stayed 0.3.7; the UI increment was not a claim of a new read/write capability. See [docs/OPS-CONFIG.md](docs/OPS-CONFIG.md).

**0.3.6** adds the root-codemode historical presentation surface: after an actual completed nested-read group, a bounded summary plus one offset-0 full-root handle for the root script output; never child raw summaries, execution cache, or future-call merge. **0.3.5** adds the strict fixed `cd <canonical trusted cwd> && <simple query>` display-surface matcher while keeping the original command execution once; no aliases, quotes, root expansion, rewrite, or new execution. **0.3.4** adds output-only governance for a strict fixed simple query surface on the original bash execute (no command rewrite/replay or execution cache), with versioned query modules and a separate gate bash observation capability. **0.3.3** adds a reviewed in-project codemode observer capability on the gate root and real Ops codemode instrumentation. Ops establishes an ALS group around the actual codemode execute and tracks nested `ToolTask` calls; a trusted gate wrapper remains count-only. No helper changes, no gate execute/config change. **0.3.2** makes the built-in `read` transparent by default when `builtinRead: "soft"`: its first successful plain-text result is bounded by the configured **content** budget (`limits.maxOutputBytes`) and the original output line/byte limits, with the exact remainder available through `ops_result`; existing diagnostics/details remain and can add framing. Its schema, path/offset/limit semantics, diagnostics, details, and errors stay the original. First-read paging is soft-only; `audit` counts an identical repeat but keeps the original full output, and `off` is untouched. A read-only codemode script keeps the snapshot boundary when Ops's actual nested-call ledger completes cleanly and every selected foreign codemode wrapper carries the exact reviewed gate observation capability. Write/edit/bash, unknown or pending calls, or an untrusted wrapper make a nested read stay native (full original result, no handle); direct reads keep transparent paging. **0.3.1** adds owner hot configuration for the ops module (`/ops-config`, its own session Doc, CAS, no restart). The five tools and strict roots/limits are unchanged. See [docs/OPS-CONFIG.md](docs/OPS-CONFIG.md). **0.3.0** adds the independent `pi-pocket-tool-gate` module. It counts actual bash call shape after Guard, supports `off`/`audit`/`gate`, and uses owner-scoped sources; audit is the initial owner-selectable mode. It does not parse shell commands, cache/replay/merge commands, or claim a hard global budget. See [docs/TOOL-GATE.md](docs/TOOL-GATE.md).

**0.2.2** adds role-policy `scope: "all" | "sources"` on top of 0.2.1. `scope: "sources"` is the first-production mode: unmatched sessions pass through, matched sources still enforce. The default remains `"all"` and preserves 0.2.1 behavior. **0.2.1** added owner hot configuration for the role policy (CAS session doc, no restart) on top of 0.2.0. Installation and enablement are deployment actions outside this README.

Deployment status and enabled/config revisions are not encoded in this README. Use the current owner rollout receipt and the modules' status commands as the source of truth; the files alone do not imply that a policy is enabled.

The repository also ships an independent drop-in, **`pi-pocket-role-policy`**. It is an owner-configured dispatch policy for the `subagent` and `team` tools. It is not part of `pi-pocket-ops`, shares no configuration, and can be installed or removed separately. It supports owner hot configuration through `/role-policy-config set <revision> <json>` (stored in its own session document, CAS on revision), so a running server does not need a restart or an environment edit. `status`, `disable`, `clear`, and `/role-policy-validate` are the other owner commands. See [docs/role-policy.md](docs/role-policy.md).

## Coverage compared with dsh-ops

This is **not** a full equivalent of `dsh-ops`. The matrix says what this version does.

| dsh-ops capability                       | `pi-pocket-ops`     | Limit                                                                                                    |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Compact reading and range/byte budgets   | Supported, bounded  | UTF-8 regular files; symlinks/hardlinks/FIFOs/devices rejected                                           |
| Continuation handles                     | Supported           | In-memory; TTL, capacity, snapshot-stale checks                                                          |
| File discovery and literal search        | Supported, bounded  | Literal only, no regex; bounded scan then sort                                                           |
| Batch reads/searches/checks              | Supported           | At most 8; shared output budget; concurrency 1..8                                                        |
| Repeat suppression on old `read`         | Supported, soft     | Always runs the original read first; only identical text                                                 |
| Transparent first-read budget            | Supported, soft     | Successful plain text only; original read semantics/errors kept                                          |
| Bash call-shape audit/gate               | Optional, owner     | Counts calls/results; no shell parsing or cost guarantee                                                 |
| Explicit batch write/edit                | Supported, explicit | 1–8 files; 1–64 edits/file; no Ops approval step; Linux pinned IO; best-effort rollback                  |
| Replace files                            | Supported, explicit | `ops_write` overwrites an existing regular file; delete is not supported                                 |
| Delete files                             | **Not supported**   | No delete tool; a failed batch keeps any new file it created and lists it instead of unlinking by path   |
| Durable per-file journal                 | Supported, owner    | `x.pi-pocket-ops.mutations`, last 16 batches, hashes/status only, no content; `/ops-mutations [call-id]` |
| Automatic native `write`/`edit` takeover | **Not supported**   | Native tools are unchanged; call `ops_write`/`ops_edit` explicitly                                       |
| Shell/command execution                  | **Not supported**   | No subprocess                                                                                            |
| PTC/programmatic tool calling            | **Not supported**   | Fixed tools only                                                                                         |
| PDF/Office document extraction           | **Not supported**   | Plain UTF-8 text only                                                                                    |
| Rust worker/background index             | **Not supported**   | Node built-ins only, no worker                                                                           |
| Dynamic tool loading                     | **Not supported**   | Exactly seven fixed tools                                                                                |

## Coverage boundaries

- **Covered:** ordinary Pocket conversations that select these drop-ins, where the module wraps the actual resolved tool: direct `bash`, codemode nested `tools.bash` (same wrapper), and background subagent children that inherit the parent extension selection. A gate `scope: "sources"` only covers a matching Owner `conversationId`/`cwd`; unmatched sessions pass through.
- **Not covered:** PiP's fixed `PIP_EXTENSIONS` list, explicit extension lists that omit the module, the Pi CLI's different extension API, MCP/internal commands, and any tool another module or host calls without going through the resolved Pocket tool wrapper. These are boundaries, not silently enforced.
- **Audit is observation:** audit and gate report call shape only. They do not prove a shell command is safe, do not reduce the number of already-made model rounds, and do not establish token/cost savings. The old `read`-round benchmark data remains versioned as historical measurement, not a gate saving claim.
- **Guard:** the gate runs after `beforeTool`/Guard and never re-judges or bypasses it. It does not alter stdout, exit, throw, timeout, or command/cwd/environment.

## Compatibility

- **Actually verified:** Pi Pocket **0.18.0** only. `minPocket` is `0.18.0`; no claim is made for older releases.
- **Official 0.19 documentation** records that legacy `content` is still accepted. 0.19 was **not run-verified** here; future versions are not guaranteed.
- Extension API **1** (`pocketApi = 1`) and the legacy `content` result.
- Linux. The module requires `/proc/self/fd` identity checks and `O_NOFOLLOW`; other platforms fail closed.
- No runtime npm dependencies. It imports only Node built-ins and Pi Pocket's `@earendil-works/pi-ai` and `@earendil-works/pi-durable`.
- Wrapped tools are shape-checked at wrap time. An unsupported built-in `read` shape is passed through with one diagnostic; an unsupported `subagent`/`team` shape is refused by the role policy. 0.19 was not run-verified.
- The role policy's effective-parent check is a pre-check, not an atomic admission; the core's final admission still decides.

## Install

1. Copy the contents of `release/dropin/` into the drop-in folder:
    - `pi-pocket-ops.ts`, `pi-pocket-ops/` (helper modules, `LICENSE`, `NOTICE`, `PROVENANCE.md`, and the owner-only Ops 配置 page `index.js` + `style.css`; Pi Pocket serves only its .js/.css, never its .ts helpers)
    - optionally `pi-pocket-role-policy.ts` and `pi-pocket-role-policy/` (independent; see [docs/role-policy.md](docs/role-policy.md))
    - optionally `pi-pocket-tool-gate.ts` and `pi-pocket-tool-gate/` (independent audit-first gate; see [docs/TOOL-GATE.md](docs/TOOL-GATE.md))
      Do not copy `node_modules`, tests, or build files.
2. Set `PI_POCKET_OPS_CONFIG` in the environment of the Pi Pocket server process (launcher, systemd unit, or shell), or configure the running server with `/ops-config set <revision> <json>` (owner-only, no restart). The role and gate companions use their own configs; see their docs. The owner-only page is served from `pi-pocket-ops/index.js` and `style.css`; **Menu → Ops 配置** reads and edits the same hot Doc with revision CAS and saves `allowedRoots`, `limits`, and `toolLayer` without a restart; roots are still validated by the original loader.
3. Restart Pi Pocket only if you changed `PI_POCKET_OPS_CONFIG` (or a role/gate environment fallback); ops, role, and gate can be enabled first and configured hot through their owner commands without a restart.
4. If `allowedRoots` or a limit is missing or invalid, every call fails closed. With correct configuration, calls work; do not expect a failure just because the module is enabled.
5. For the role policy, set `PI_POCKET_ROLE_POLICY_CONFIG` before enabling it. Missing or invalid config makes `subagent spawn` and `team start` fail closed with an explicit error; it installs no fallback.

Example:

```json
{
    "allowedRoots": ["/home/owner/work"],
    "limits": {
        "maxOutputBytes": 32768,
        "maxFileBytes": 4194304,
        "timeoutMs": 5000
    }
}
```

`allowedRoots` is required and must be a non-empty array of absolute, canonical, existing directories. A root may not be `/`, the home folder or its ancestor, Pi Pocket's data or agent folders, credential folders, or system internals. The session's trusted cwd must be a real directory inside one allowed root. The model cannot choose a root or an absolute path.

All limits are optional. Defaults and hard ranges:

| Key                   | Default | Allowed           |
| --------------------- | ------: | ----------------- |
| `maxOutputBytes`      |   32768 | 256..262144       |
| `maxBatchOutputBytes` |   65536 | 256..262144       |
| `maxFileBytes`        | 4194304 | 1024..16777216    |
| `maxSearchFileBytes`  | 1048576 | 1..`maxFileBytes` |
| `maxScanEntries`      |    2000 | 1..20000          |
| `maxScanBytes`        | 8388608 | 1..67108864       |
| `maxDepth`            |       8 | 0..16             |
| `timeoutMs`           |    5000 | 100..30000        |
| `batchTimeoutMs`      |   15000 | 100..60000        |
| `maxBatchOps`         |       8 | 1..8              |
| `batchConcurrency`    |       1 | 1..8              |
| `batchItemTimeoutMs`  |    5000 | 100..30000        |
| `maxMatches`          |     200 | 1..1000           |
| `maxMatchLineBytes`   |     400 | 64..4096          |
| `handleTtlMs`         |  300000 | 1000..3600000     |
| `maxHandles`          |      64 | 1..256            |
| `maxHandlesPerScope`  |      16 | 1..`maxHandles`   |
| `maxHandleBytes`      | 4194304 | 65536..16777216   |

`toolLayer` is optional and has its own switch and budgets:

```json
{
    "toolLayer": {
        "enabled": true,
        "dedup": "off",
        "builtinRead": "soft",
        "builtinReadMinBytes": 512,
        "builtinReadMinSavingsBytes": 64,
        "maxEntries": 32,
        "maxBytes": 1048576,
        "maxSessions": 64,
        "sessionTtlMs": 900000
    }
}
```

- `enabled: false` makes the installed layer behavior inactive/pass-through, not an uninstall of wraps or the invalidation hook; the seven tools still work.
- `dedup` applies to `ops_read`/`ops_search` only; default `"off"` preserves their v0.1 text (the batch envelope is still v0.2). `"audit"` keeps the full result and counts the repeat in `/ops-stats`. `"soft"` returns a compact handle-only repeat.
- `builtinRead` applies to the built-in `read` only; default `"soft"` first pages a successful plain-text result over the configured **content** budget `limits.maxOutputBytes` (the exact remainder is available through `ops_result`) and compacts only a byte-identical repeat. `"audit"` only counts an identical repeat and keeps the original full output; `"off"` restores the untouched built-in output. Original diagnostics/details are retained; the host may add framing.
- Query output governance follows `toolLayer.enabled` and the existing `limits.maxOutputBytes`; it is independent of `builtinRead` mode. It recognizes only the strict simple `rg/grep/stat/wc/ls` surface, or the exact fixed `cd <canonical cwd> &&` prefix around that surface, runs the original bash command once, and never gives shell/read authorization or caches execution. Operand paths are not re-authorized by Ops: the original bash permission already governs what reaches stdout, so the historical display snapshot is not a file ACL or secret filter. cwd-under-Work is only output-governance eligibility. Unsupported/compound commands, failures, spills, and foreign wrappers stay native.
- `builtinReadMinSavingsBytes` suppresses only when the compact replacement is at least that much smaller; a replacement that is not smaller is passed through.
- `maxEntries`/`maxBytes` bound each session's caches. `maxSessions` and `sessionTtlMs` bound the global session map; dispose clears it.
- Batch search does not reuse cached search snapshots, so freshness revalidation cannot read outside the batch share. If another extension wraps a reader/result tool or has a `ToolTask.afterTool` hook, replay is disabled and `ops_batch` read/search items fail closed (`code="compat"`); call the original wrapped tool directly. `ops_check`-only batches remain available. The stand-down is sticky while that session state is retained; `sessionTtlMs`/`maxSessions` eviction or reload/restart re-evaluates it, an active wrapper is detected on each call, and an observed stand-down revokes only that scope's handles. This is not claimed as a hard security boundary.

Unknown top-level keys, unknown limit keys, and unknown `toolLayer` keys are rejected without echoing the key. The module reads this environment value when it loads, so reload or restart after changing it.

## Tools

### `ops_read { path, offset?, limit?, maxBytes?, maxTokens?, fresh? }`

- `path` is relative to the session cwd. No absolute paths, `..`, backslashes, hidden names, credential paths, symlinks, or hard-linked files.
- `offset` is 1-based; `limit` defaults to 200 lines and is capped at 2000.
- Output uses compact `line|text` prefixes. A line fragment uses `line@byteOffset|text`.
- A long line is split only at UTF-8 code-point boundaries. The next page continues at the exact byte; characters are not lost or repeated.
- If the whole final text would exceed the budget, the page carries a handle bound to the original file snapshot. This includes a cut exactly on a line boundary inside the requested window.
- If the requested `offset..offset+limit-1` window is fully returned, `done="true"`. `next_offset` is only a hint for a **new independent range read**, not a continuation of the original snapshot.
- `fresh: true` bypasses session repeat suppression for this call.

### `ops_search { path?, query?, mode?, maxBytes?, maxTokens?, fresh? }`

- `mode: "files"` lists files and directories, optionally filtered by a case-insensitive literal name substring.
- `mode: "text"` searches literal, case-sensitive text per line. A query is never compiled as a regex.
- The default mode is `text` when a non-empty `query` is present, otherwise `files`.
- Results are stable-sorted by relative path and line. Every result line is bounded.
- Scan budgets count every directory entry seen (including hidden and excluded names) and every byte read, including files that turn out to be binary, invalid UTF-8, or change while being read. Every touched regular file is recorded; a later change invalidates the handle.
- **Bounded scan, then sort.** Results are the stable-sorted subset that was actually scanned. A huge directory that hits the entry/byte/depth budget is not guaranteed to return the globally first N names in dictionary order; it returns the scanned subset plus `scan_truncated`/`depth_truncated` flags. This is not an atomic tree snapshot or full-filesystem race isolation. Existing scanned directories and files are revalidated before continuation.

### `ops_check { path, hash?, maxBytes?, maxTokens? }`

- Returns `path`, `ref`, `size`, `changed`, optional `hash`, and no file content.
- `ref` is a metadata fingerprint (`mtime`, `ctime`, size, inode) unless `hash: true`, which reads under `maxFileBytes` and returns a 16-hex SHA-256 prefix (not the full digest).
- `changed` compares with this session's last successful read of the same path; it is omitted when there is none. It is a hint, not a security decision.

### `ops_batch { operations, concurrency?, itemTimeoutMs?, maxBytes?, maxTokens? }`

- Operations are `ops_read`/`ops_search`/`ops_check` discriminated objects, 1 to 8 per batch.
- `concurrency` defaults to 1 (serial). Serial mode shares one scan budget. Parallel mode divides `maxScanBytes`/`maxScanEntries` into `concurrency` slots, so the total cannot exceed the configured cap.
- `dependsOn` (1-based, earlier only) makes a parallel item wait for that item. It does not create a write or a correctness guarantee for independent reads.
- `itemTimeoutMs` is per item. One item's timeout or safe error does not stop the others; caller cancellation and module disposal do.
- Each item gets the smallest of its share of the total output budget, its own `maxBytes`, and its own `maxTokens * 4`.
- Output is one compact `<ops_batch v="2">` envelope. A cut item carries a `handle` for `ops_result`, or `recover="retry"`; errors carry `status="error" code="..." msg="..."`.
- Nested batch, `ops_result`, shell, writes, and arbitrary tool names are rejected by the schema.

### `ops_result { handle, maxBytes?, maxTokens?, release? }`

- Continues a truncated read or search page, or replays an earlier built-in `read` while its mutation epoch is current.
- A built-in-read replay is text-only and epoch-bound: any mutation, including `bash`, makes it a handle miss. It is not a file read and does not bypass the ops roots for new content.
- Handles are random, in-memory, TTL-bound, capacity-bound, and scoped to conversation + requester + canonical cwd + cwd identity.
- Unknown, expired, other-scope, busy, or changed snapshots return one safe error and ask for the original tool again. A different scope cannot revoke the original owner's handle.
- A stale file, directory, cwd replacement, or changed scanned file invalidates the handle.
- `release: true` drops the handle.
- Restart, reload, or disabling the module drops every handle. This is a disposable page cache, not durable state.
- The session layer's soft gate is not enforcement. It can be turned off, bypassed with `ops_read fresh=true`, and it never prevents a tool call. It only suppresses exact repeated output.

## Output budget

`maxBytes` and `maxTokens` bound the **complete final text**: tags, header, note, footer, fences, metadata, and content. `maxTokens` is only a heuristic: the effective byte budget is `maxTokens * 4`. Fields named `tokens_budget_est` are estimates of the byte budget, not provider token counts.

Minimum legal budget is 256 bytes (`maxBytes >= 256`, or `maxTokens >= 64`). If an internal calculation cannot fit even the fixed error tag, the output is a short `ops: error` prefix, still within the budget.

## Security model and limits

This module reduces accidental exposure and resource exhaustion. It is **not** a sandbox and cannot protect against a compromised server process or a malicious drop-in running beside it.

- **Trusted inputs only for roots:** the owner's JSON environment and `(await api.agent(context)).cwd`. Tool arguments can choose only relative paths below that cwd.
- **Writes only through the explicit tools:** `ops_write`/`ops_edit` are the only write path. They request no Ops approval, use pinned no-follow descriptors, and never replace the native `write`/`edit` tools. There is no shell, process, network, download, `eval`, or worker path. Guard does not automatically see `ops_*`; normal `beforeTool` hooks still run and can block, but they are not an Ops approval prompt.
- **No model-selected roots, permissions, or approval flags:** tool arguments carry only relative paths and content/edits. Roots, the requester, and the call identity come from the host.
- **Session layer:** it wraps only at `execute`, after Guard and every `beforeTool` hook. A blocked call never reaches it. The built-in `read` always runs first; its compact repeat is based on the fresh result. Failures are never cached. Any tool that is not a known pure reader invalidates the epoch, including `bash`, `write`, `edit`, `subagent`, `team`, and unknown tools. `codemode` is preserved only by the actual nested-call ledger and exact gate capability; otherwise it invalidates. Bash is not parsed or blocked.
- **Symlinks and hard links:** every path component is opened with `O_NOFOLLOW`; regular files must have exactly one link. FIFOs and devices are opened with `O_NONBLOCK`, then rejected because they are not regular files.
- **TOCTOU:** opened objects are checked through `/proc/self/fd`; parent directories and the cwd are re-checked by identity (dev/ino). Reads compare a SHA-256 snapshot. Writes keep the parent and target descriptors open, recheck cwd/root/parent/target/original content before writing, and write only through the bound descriptor. A moved parent directory or replaced file invalidates the plan.
- **Cooperative timeout/cancel:** `timeoutMs`, `batchTimeoutMs`, and abort signals are checked between asynchronous operations and read chunks. They stop further work and discard output, but they cannot cancel a kernel, NFS, or FUSE syscall already blocked in the thread pool. This is not a hard real-time bound or a hard filesystem sandbox.
- **Deny list, not a secret scanner:** hidden names, `.git`, `node_modules`, `raw`, `original`, `原文`, `uploads`, `attachments`, `secrets`, `credentials`, `auth`/`auth.json`, and common key extensions are denied even for an explicit read. The list cannot find every secret; do not point roots at unrelated sensitive data.
- **Handles:** in-memory only, never written to disk or a public location. They are not a per-person privacy boundary: everyone who can see the session, and the model provider, can see the tool text.
- **Shared sessions:** scoping uses the current requester, conversation, cwd, and cwd identity. This prevents accidental cross-use and cross-scope revocation; it does not make a shared session private.
- **Errors:** no absolute paths, raw exceptions, file content, or confirmation that an unknown handle exists. Unexpected failures return a generic safe message.

## Privacy

- **No network, telemetry, analytics, subprocess, `npm install`, `npx`, downloaded code, or self-update.**
- File content, file names, query text, and search results become tool results. They go to the model provider and are visible to everyone who can see the session, including exports.
- The only host data read is the cwd and requester identity supplied by Pi Pocket. Configuration comes from `PI_POCKET_OPS_CONFIG`.
- No secrets should be placed in a root. The deny list is conservative but not complete.

## Uninstall and rollback

See [docs/INSTALL.md](docs/INSTALL.md) and [docs/ROLLBACK.md](docs/ROLLBACK.md). In short:

1. Turn off `pi-pocket-role-policy.ts` and `pi-pocket-tool-gate.ts` if installed. Their owner commands (`/role-policy-config disable|clear <revision>`, `/tool-gate-config disable|clear <revision>`) are the no-restart rollback; persistent docs remain.
2. Remove the role/gate target files if uninstalling. The role/gate hot docs are durable and are not deleted through SQLite/core data.
3. For the ops module, turn it off/remove `pi-pocket-ops.ts` and `pi-pocket-ops/`; changing/removing `PI_POCKET_OPS_CONFIG` and clearing handles require its usual reload/restart. Removing only `pi-pocket-ops/index.js` and `style.css` removes the page, not the tools. The role/gate modules do not require that restart.
4. Do not delete other extensions or Pi Pocket data.

Ops keeps state in memory only; the role and gate modules intentionally persist their own configuration docs. Rolling back ops to an earlier copy invalidates its handles; call the original tool again.

## Package and gallery status

`npm run package` writes a local `release/` folder:

- `release/dropin/` — exactly the files to install, including the independent `pi-pocket-role-policy` companion. Each module folder carries `LICENSE`, `NOTICE`, and `PROVENANCE.md` so the installed copy keeps its legal/source notice.
- `release/manifest.json` — version, `pocketApi`, `minPocket`, license, tool names, file sizes and SHA-256, and total size.
- `release/gallery-entry.draft.json` — a template with explicit placeholders. It is **not** a published gallery entry and contains no invented repository or commit. Fill in `source.repo` and `source.commit` only after a real public commit exists, then run the gallery's checks.
- `release/README.md`, `release/LICENSE`, `release/NOTICE`, `release/PROVENANCE.md`.

The packaging script refuses more than 50 files, a file over 512 KiB, more than 2 MiB total, invalid gallery paths, hidden files, `node_modules`, absolute imports, and forbidden runtime APIs. In the installed folder it allows `.ts` code, the two owner browser files `pi-pocket-ops/index.js` and `pi-pocket-ops/style.css`, and the three explicit legal/source files; the TypeScript runtime scan and a browser-API scan for the UI reject forbidden APIs and imports, and any other extra file is refused. The gallery draft includes those two files; the official file-path check accepts them inside the module folder.

## Development

The project expects a sibling Pi Pocket 0.18 development checkout for types and lint/format tools. A common local setup is:

```bash
ln -s ../pi-pocket-dev/node_modules node_modules
npm run check
npm run lint
npm run format:check
npm test
npm run package
```

`tests/` and `test-support/` are maintained by the independent test role. This module does not modify them.

## License and provenance

MIT. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [PROVENANCE.md](PROVENANCE.md). This is an independent implementation inspired by the design of `dsh-ops`; no code or algorithm fragment was copied. It is not a full-feature equivalent of `dsh-ops`, and it does not include FastCtx code or its license/NOTICE, or a Windows Bash component.
