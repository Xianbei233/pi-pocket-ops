/**
 * Owner-only Ops configuration surface for the official Pocket menu: two owner routes over the existing
 * `x.pi-pocket-ops.config` document, plus the browser files in `pi-pocket-ops/`.
 *
 * This helper is versioned in its file name on purpose. Pi Pocket does not import a changed helper again until the
 * server restarts, so a later change must come as a new `settings-vNNN.ts` path imported by the module, not as an edit
 * to this file. The module imports it first; `config.ts` and the other runtime helpers stay byte-identical.
 *
 * The routes never accept authority from a model tool argument. `access: "owner"` and a second `user.role` check guard
 * both; every write goes through the same `loadConfig` validation and the same revision CAS as `/ops-config`.
 */

import { loadConfig } from "./config.ts";
import type {
    Config,
    ConfigState,
    LayerConfig,
    Limits,
    OpsConfigValue,
    OpsDoc,
    OpsHost,
    OpsWeb,
    OpsWebRequest,
    OpsWriteTx,
} from "./types.ts";

/** The ops package version this file documents. `package.json` and `scripts/package.ts` stay authoritative. */
export const OPS_PACKAGE_VERSION = "0.3.7";

/** The configuration UI increment on top of the unchanged runtime package version. */
export const SETTINGS_UI_VERSION = "settings.1";

/** The browser folder right beside `pi-pocket-ops.ts`. */
export const SETTINGS_CLIENT = "pi-pocket-ops";

const ACTIONS = ["save", "disable", "enable", "clear", "defaults"] as const;

type SettingsAction = (typeof ACTIONS)[number];

const MAX_REVISION = Number.MAX_SAFE_INTEGER;

interface SurfaceOptions {
    readonly host: OpsHost;
    readonly web: OpsWeb;
    /** The module's single `OpsConfigDoc` token; this helper never defines a second document. */
    readonly doc: unknown;
    /** `PI_POCKET_OPS_CONFIG` captured at module load; helper fallbacks never read process.env again. */
    readonly capturedRaw: string | undefined;
    /** Retire the old runtime so the next call reads the committed revision; active calls finish on the old one. */
    readonly onChanged: (revision: number) => void;
}

interface ViewConfig {
    readonly allowedRoots: readonly string[];
    readonly limits: Limits;
    readonly toolLayer: LayerConfig;
}

interface SettingsView {
    readonly ok: true;
    readonly extension: "pi-pocket-ops";
    readonly opsVersion: string;
    readonly configUiVersion: string;
    readonly uiVersion: string;
    readonly hostVersion: string | null;
    readonly api: number | null;
    readonly source: "document" | "environment" | "absent";
    readonly revision: number | null;
    readonly disabled: boolean;
    readonly active: boolean;
    readonly reason: string | null;
    readonly config: ViewConfig | null;
    readonly defaults: { readonly limits: Limits; readonly toolLayer: LayerConfig } | null;
    readonly defaultsReason: string | null;
    readonly capabilities: {
        readonly read: boolean;
        readonly write: boolean;
        readonly reason: string | null;
    };
}

interface WritePlan {
    readonly json?: string;
    readonly disabled?: boolean;
}

class CommitRefusal extends Error {
    readonly kind: "conflict" | "shape";

    constructor(kind: "conflict" | "shape", message: string) {
        super(message);
        this.kind = kind;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueProblem(doc: {
    readonly json?: unknown;
    readonly revision?: unknown;
    readonly disabled?: unknown;
}): string | undefined {
    if (typeof doc.json !== "string") {
        return "json must be a string";
    }

    if (
        typeof doc.revision !== "number" ||
        !Number.isSafeInteger(doc.revision) ||
        doc.revision < 0
    ) {
        return "revision must be a non-negative safe integer";
    }

    if (typeof doc.disabled !== "boolean") {
        return "disabled must be a boolean";
    }

    return undefined;
}

function revisionOf(value: unknown): number | undefined {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value < MAX_REVISION
        ? value
        : undefined;
}

/** A safe HTTP error; an older host without `web.error` still gets a plain error and no authority bypass. */
function routeError(web: OpsWeb, status: number, message: string): Error {
    return typeof web.error === "function" ? web.error(status, message) : new Error(message);
}

function asViewConfig(config: Config): ViewConfig {
    return {
        allowedRoots: [...config.roots],
        limits: config.limits,
        toolLayer: config.layer,
    };
}

/** Validate a complete replacement of the document JSON through the original config loader. */
async function parseSettings(
    host: OpsHost,
    raw: unknown,
): Promise<
    { readonly ok: true; readonly json: string } | { readonly ok: false; readonly reason: string }
> {
    if (!isRecord(raw)) {
        return { ok: false, reason: "settings must be an object" };
    }

    for (const key of Object.keys(raw)) {
        if (key !== "allowedRoots" && key !== "limits" && key !== "toolLayer") {
            return { ok: false, reason: "settings has an unknown field" };
        }
    }

    if (!Array.isArray(raw.allowedRoots)) {
        return { ok: false, reason: "settings.allowedRoots must be an array" };
    }

    if (raw.limits !== undefined && !isRecord(raw.limits)) {
        return { ok: false, reason: "settings.limits must be an object" };
    }

    if (raw.toolLayer !== undefined && !isRecord(raw.toolLayer)) {
        return { ok: false, reason: "settings.toolLayer must be an object" };
    }

    let json: string;

    try {
        json = JSON.stringify({
            allowedRoots: raw.allowedRoots,
            ...(raw.limits === undefined ? {} : { limits: raw.limits }),
            ...(raw.toolLayer === undefined ? {} : { toolLayer: raw.toolLayer }),
        });
    } catch {
        return { ok: false, reason: "settings cannot be encoded as JSON" };
    }

    const checked = await loadConfig(host, json);

    return checked.ok ? { ok: true, json } : { ok: false, reason: checked.reason };
}

function defaultsFor(
    host: OpsHost,
    root: string,
): Promise<
    | { readonly ok: true; readonly limits: Limits; readonly toolLayer: LayerConfig }
    | { readonly ok: false }
> {
    return loadConfig(host, JSON.stringify({ allowedRoots: [root] })).then((checked) =>
        checked.ok
            ? { ok: true, limits: checked.config.limits, toolLayer: checked.config.layer }
            : { ok: false as const },
    );
}

export function registerOpsSettings(options: SurfaceOptions): void {
    const { host, web, doc, capturedRaw, onChanged } = options;
    const envState = (): Promise<ConfigState> =>
        loadConfig(host, capturedRaw === undefined ? "" : capturedRaw);

    if (typeof web.route !== "function") {
        return;
    }

    const ownerOnly = (request: OpsWebRequest): void => {
        // `access: "owner"` already hides the route; this second check keeps a future access edit from widening it.
        if (request.user?.role !== "owner") {
            throw routeError(web, 404, "Not found");
        }
    };

    const readDoc = async (
        request: OpsWebRequest,
    ): Promise<
        | {
              readonly ok: true;
              readonly value: OpsConfigValue | null;
              readonly problem: string | null;
              readonly present: boolean;
          }
        | { readonly ok: false; readonly status: number; readonly error: string }
    > => {
        if (typeof request.snapshot !== "function") {
            return {
                ok: false,
                status: 503,
                error: "配置读取不可用：服务器缺少 snapshot API（需要 Pi Pocket 0.16+）",
            };
        }

        let raw: OpsDoc | undefined;

        try {
            raw = await request.snapshot(doc, request.context);
        } catch {
            return {
                ok: false,
                status: 503,
                error: "配置文档读取失败；未改用环境变量兜底，也未放宽任何根目录",
            };
        }

        if (raw === undefined) {
            return { ok: true, value: null, problem: null, present: false };
        }

        const problem = valueProblem(raw);

        if (problem !== undefined) {
            return { ok: true, value: null, problem, present: true };
        }

        return {
            ok: true,
            value: {
                json: raw.json as string,
                revision: raw.revision as number,
                disabled: raw.disabled as boolean,
            },
            problem: null,
            present: true,
        };
    };

    const buildView = async (request: OpsWebRequest): Promise<SettingsView> => {
        const read = await readDoc(request);

        if (!read.ok) {
            throw routeError(web, read.status, read.error);
        }

        const value = read.value;
        const source: SettingsView["source"] =
            value !== null
                ? value.json === ""
                    ? "environment"
                    : "document"
                : read.present
                  ? "document"
                  : "absent";
        const disabled = value?.disabled ?? false;
        const revision = read.problem === null ? (value?.revision ?? 0) : null;
        const hostVersion =
            typeof host.pocketVersion === "string" && host.pocketVersion.trim() !== ""
                ? host.pocketVersion
                : null;

        let state: ConfigState;

        if (read.problem !== null) {
            state = { ok: false, reason: `配置文档形状无效（${read.problem}）` };
        } else if (value !== null && value.json !== "") {
            state = await loadConfig(host, value.json);
        } else {
            state = await envState();
        }

        const active = read.problem === null && !disabled && state.ok;
        const reason =
            read.problem !== null
                ? `配置文档形状无效（${read.problem}）；页面只读`
                : disabled
                  ? "配置文档已禁用（disabled=true）：ops 工具 fail closed；内置 read 直通。"
                  : state.ok
                    ? null
                    : state.reason;

        let defaults: SettingsView["defaults"] = null;
        let defaultsReason: string | null = null;

        if (state.ok) {
            const root = state.config.roots[0];

            if (root === undefined) {
                defaultsReason = "当前配置没有 allowedRoots，无法计算默认值";
            } else {
                const found = await defaultsFor(host, root);

                if (found.ok) {
                    defaults = { limits: found.limits, toolLayer: found.toolLayer };
                } else {
                    defaultsReason = "当前 allowedRoots 未通过复验，无法计算默认值";
                }
            }
        } else {
            defaultsReason = "需要一份通过校验的 allowedRoots 才能计算默认值";
        }

        const write = typeof request.commit === "function" && read.problem === null;
        const writeReason =
            typeof request.commit !== "function"
                ? "服务器缺少 commit API：页面只读（需要 Pi Pocket 0.16+）"
                : read.problem !== null
                  ? "配置文档形状无效：页面只读"
                  : null;

        return {
            ok: true,
            extension: "pi-pocket-ops",
            opsVersion: OPS_PACKAGE_VERSION,
            configUiVersion: SETTINGS_UI_VERSION,
            uiVersion: `${OPS_PACKAGE_VERSION}+${SETTINGS_UI_VERSION}`,
            hostVersion,
            api: typeof web.api === "number" ? web.api : null,
            source,
            revision,
            disabled,
            active,
            reason,
            config: state.ok ? asViewConfig(state.config) : null,
            defaults,
            defaultsReason,
            capabilities: { read: true, write, reason: writeReason },
        };
    };

    const commitCas = async (
        request: OpsWebRequest,
        expected: number,
        plan: WritePlan,
    ): Promise<number> => {
        if (typeof request.commit !== "function") {
            throw routeError(web, 503, "配置写入不可用：服务器缺少 commit API；页面只读");
        }

        let currentRevision: number | undefined;

        try {
            const revision = await request.commit(async (tx: OpsWriteTx) => {
                const current = await tx.doc(doc);
                const problem = valueProblem(current);

                if (problem !== undefined) {
                    throw new CommitRefusal("shape", problem);
                }

                if (current.revision !== expected) {
                    currentRevision = current.revision;

                    throw new CommitRefusal("conflict", "");
                }

                if (plan.json !== undefined) {
                    current.json = plan.json;
                }

                if (plan.disabled !== undefined) {
                    current.disabled = plan.disabled;
                }

                current.revision = expected + 1;

                return current.revision;
            });

            onChanged(revision);

            return revision;
        } catch (error) {
            if (error instanceof CommitRefusal) {
                if (error.kind === "conflict") {
                    throw routeError(
                        web,
                        409,
                        `revision 冲突（期望 ${expected}，当前 ${currentRevision ?? "未知"}）；配置未修改，请刷新后重试`,
                    );
                }

                throw routeError(web, 409, `配置文档形状无效（${error.message}）；配置未修改`);
            }

            // Never echo a storage error: it can name a data folder. The old document is untouched on failure.
            throw routeError(web, 503, "配置提交失败；配置未修改");
        }
    };

    const write = async (
        request: OpsWebRequest,
    ): Promise<{
        readonly ok: true;
        readonly action: SettingsAction;
        readonly revision: number;
    }> => {
        // Without a read capability the surface cannot show what it would replace; keep it unavailable, not write-only.
        if (typeof request.snapshot !== "function") {
            throw routeError(web, 503, "配置写入不可用：服务器缺少 snapshot API；页面只读");
        }

        const body = isRecord(request.body) ? request.body : {};

        for (const key of Object.keys(body)) {
            if (key !== "expectedRevision" && key !== "action" && key !== "settings") {
                throw routeError(web, 400, "请求包含未知字段；拒绝写入");
            }
        }

        const expected = revisionOf(body.expectedRevision);

        if (expected === undefined) {
            throw routeError(web, 400, "expectedRevision 必须是非负安全整数");
        }

        const action = body.action;

        if (typeof action !== "string" || !ACTIONS.includes(action as SettingsAction)) {
            throw routeError(web, 400, "action 必须是 save、disable、enable、clear 或 defaults");
        }

        const chosen = action as SettingsAction;
        const hasSettings = Object.hasOwn(body, "settings");

        if (chosen !== "save" && hasSettings) {
            throw routeError(web, 400, "只有 save 接受 settings");
        }

        let plan: WritePlan;

        if (chosen === "save") {
            if (!hasSettings) {
                throw routeError(web, 400, "save 需要 settings");
            }

            const parsed = await parseSettings(host, body.settings);

            if (!parsed.ok) {
                throw routeError(web, 400, `配置未通过校验：${parsed.reason}`);
            }

            plan = { json: parsed.json };
        } else if (chosen === "disable") {
            plan = { disabled: true };
        } else if (chosen === "clear") {
            plan = { json: "" };
        } else {
            const read = await readDoc(request);

            if (!read.ok) {
                throw routeError(web, read.status, read.error);
            }

            if (read.problem !== null) {
                throw routeError(web, 409, `配置文档形状无效（${read.problem}）；配置未修改`);
            }

            const value = read.value;
            const state =
                value !== null && value.json !== ""
                    ? await loadConfig(host, value.json)
                    : await envState();

            if (chosen === "enable") {
                if (!state.ok) {
                    throw routeError(web, 409, `当前配置无效，不能启用：${state.reason}`);
                }

                plan = { disabled: false };
            } else {
                if (!state.ok) {
                    throw routeError(
                        web,
                        409,
                        `当前配置没有可保留的合法 allowedRoots，不能恢复默认：${state.reason}`,
                    );
                }

                const root = state.config.roots[0];

                if (root === undefined) {
                    throw routeError(web, 409, "当前配置没有 allowedRoots，不能恢复默认");
                }

                const defaults = await defaultsFor(host, root);

                if (!defaults.ok) {
                    throw routeError(web, 409, "默认值复验失败；配置未修改");
                }

                const json = JSON.stringify({
                    allowedRoots: state.config.roots,
                    limits: defaults.limits,
                    toolLayer: defaults.toolLayer,
                });
                const checked = await loadConfig(host, json);

                if (!checked.ok) {
                    throw routeError(web, 409, `默认值复验失败：${checked.reason}；配置未修改`);
                }

                plan = { json };
            }
        }

        const revision = await commitCas(request, expected, plan);

        return { ok: true, action: chosen, revision };
    };

    web.route(
        "GET",
        "settings",
        async (request) => {
            ownerOnly(request);

            return buildView(request);
        },
        { access: "owner" },
    );
    web.route(
        "POST",
        "settings",
        async (request) => {
            ownerOnly(request);

            return write(request);
        },
        { access: "owner" },
    );

    if (typeof web.client === "function") {
        try {
            web.client(SETTINGS_CLIENT, { access: "owner" });
        } catch {
            // A source install may copy only the module and helper folder. Keep the read-only tools loading; the
            // page is simply absent until the operator also installs `pi-pocket-ops/index.js` and `style.css`.
        }
    }
}
