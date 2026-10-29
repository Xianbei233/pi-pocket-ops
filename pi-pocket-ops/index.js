/**
 * Owner-only Ops configuration page and menu row for Pi Pocket's official App group.
 *
 * Every read and write goes through the module's own owner routes. This browser module holds no grants: the server
 * checks the owner role again and validates every value with the original ops config loader.
 */

export const pocketApi = 1;

const LIMIT_FIELDS = [
    { key: "maxOutputBytes", label: "单次输出上限" },
    { key: "maxBatchOutputBytes", label: "批量输出上限" },
    { key: "maxFileBytes", label: "单文件上限" },
    { key: "maxSearchFileBytes", label: "搜索单文件上限" },
    { key: "maxScanEntries", label: "扫描条目上限" },
    { key: "maxScanBytes", label: "扫描字节上限" },
    { key: "maxDepth", label: "遍历深度" },
    { key: "timeoutMs", label: "读取超时 ms" },
    { key: "batchTimeoutMs", label: "批量超时 ms" },
    { key: "maxBatchOps", label: "批量操作数" },
    { key: "batchConcurrency", label: "批量并发" },
    { key: "batchItemTimeoutMs", label: "批量单项超时 ms" },
    { key: "maxMatches", label: "匹配数上限" },
    { key: "maxMatchLineBytes", label: "匹配行字节" },
    { key: "handleTtlMs", label: "分页 handle TTL ms" },
    { key: "maxHandles", label: "handle 总数" },
    { key: "maxHandlesPerScope", label: "每范围 handle 数" },
    { key: "maxHandleBytes", label: "handle 字节上限" },
];

const LAYER_NUMBER_FIELDS = [
    { key: "builtinReadMinBytes", label: "builtinRead 最小字节" },
    { key: "builtinReadMinSavingsBytes", label: "builtinRead 最小节省" },
    { key: "maxEntries", label: "层条目上限" },
    { key: "maxBytes", label: "层字节上限" },
    { key: "maxSessions", label: "层会话上限" },
    { key: "sessionTtlMs", label: "层会话 TTL ms" },
];

function draftFrom(view) {
    const config = view?.config;

    if (!config) {
        return { roots: [""], limits: {}, toolLayer: {} };
    }

    const limits = {};

    for (const field of LIMIT_FIELDS) {
        limits[field.key] = String(config.limits[field.key]);
    }

    const layer = config.toolLayer;
    const toolLayer = {
        enabled: layer.enabled === true,
        dedup: layer.dedup,
        builtinRead: layer.builtinRead,
    };

    for (const field of LAYER_NUMBER_FIELDS) {
        toolLayer[field.key] = String(layer[field.key]);
    }

    return { roots: [...config.allowedRoots], limits, toolLayer };
}

function buildSettings(draft) {
    const roots = draft.roots.map((root) => root.trim()).filter((root) => root !== "");

    if (roots.length === 0) {
        throw new Error("至少需要一个 allowedRoots 路径");
    }

    const limits = {};

    for (const field of LIMIT_FIELDS) {
        const raw = draft.limits[field.key];

        if (raw === undefined || String(raw).trim() === "") {
            continue;
        }

        const value = Number(raw);

        if (!Number.isSafeInteger(value)) {
            throw new Error(`limits.${field.key} 必须是整数`);
        }

        limits[field.key] = value;
    }

    const toolLayer = {};

    if (draft.toolLayer.enabled !== undefined) {
        toolLayer.enabled = draft.toolLayer.enabled === true;
    }

    if (draft.toolLayer.dedup) {
        toolLayer.dedup = draft.toolLayer.dedup;
    }

    if (draft.toolLayer.builtinRead) {
        toolLayer.builtinRead = draft.toolLayer.builtinRead;
    }

    for (const field of LAYER_NUMBER_FIELDS) {
        const raw = draft.toolLayer[field.key];

        if (raw === undefined || String(raw).trim() === "") {
            continue;
        }

        const value = Number(raw);

        if (!Number.isSafeInteger(value)) {
            throw new Error(`toolLayer.${field.key} 必须是整数`);
        }

        toolLayer[field.key] = value;
    }

    return {
        allowedRoots: roots,
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
        ...(Object.keys(toolLayer).length > 0 ? { toolLayer } : {}),
    };
}

function sourceText(view) {
    if (view.source === "document") {
        return view.revision === null
            ? "配置文档（形状无效，页面只读）"
            : `配置文档 revision ${view.revision}`;
    }

    if (view.source === "environment") {
        return `文档 JSON 为空 → 环境变量回退（revision ${view.revision}）`;
    }

    return "文档缺失 → 环境变量回退";
}

export default function setup(pocket) {
    const { html, useState, useEffect } = pocket;

    try {
        pocket.style("style.css");
    } catch {
        // A single-file host has no stylesheet folder; the page stays usable with the app's own classes.
    }

    function OpsSettings() {
        const [view, setView] = useState(null);
        const [draft, setDraft] = useState(null);
        const [message, setMessage] = useState(null);
        const [busy, setBusy] = useState(false);
        const [confirming, setConfirming] = useState(null);

        const fetchView = (signal) =>
            pocket.api("settings", undefined, signal ? { signal } : undefined);

        useEffect(() => {
            const stop = new AbortController();

            fetchView(stop.signal).then(
                (next) => {
                    setView(next);
                    setDraft(draftFrom(next));
                },
                (failure) => {
                    if (!stop.signal.aborted) {
                        setMessage({
                            kind: "error",
                            text: failure?.message || "读取 Ops 配置失败",
                        });
                    }
                },
            );

            return () => stop.abort();
        }, []);

        async function reload(keepDraft) {
            try {
                const next = await fetchView();

                setView(next);

                if (!keepDraft) {
                    setDraft(draftFrom(next));
                }

                return next;
            } catch (failure) {
                setMessage({ kind: "error", text: failure?.message || "读取 Ops 配置失败" });

                return null;
            }
        }

        async function send(action, settings) {
            if (!view || view.revision === null || view.capabilities?.write !== true) {
                setMessage({
                    kind: "error",
                    text: view?.capabilities?.reason || "页面只读，未发送写入",
                });

                return;
            }

            const body = { expectedRevision: view.revision, action };

            if (settings !== undefined) {
                body.settings = settings;
            }

            setBusy(true);

            try {
                const result = await pocket.api("settings", body);
                const next = await fetchView();

                setView(next);
                setDraft(draftFrom(next));
                setMessage({ kind: "ok", text: `已写入 revision ${result.revision}` });
            } catch (failure) {
                if (failure?.status === 409) {
                    setMessage({
                        kind: "warn",
                        text: `${failure.message}；已重新读取当前 revision，保留本页草稿，未覆盖任何配置。`,
                    });

                    try {
                        setView(await fetchView());
                    } catch {
                        // The conflict message already explains the state.
                    }
                } else {
                    setMessage({ kind: "error", text: failure?.message || "写入失败" });
                }
            } finally {
                setBusy(false);
            }
        }

        function updateRoot(index, value) {
            setDraft((current) => {
                const roots = [...current.roots];

                roots[index] = value;

                return { ...current, roots };
            });
        }

        function addRoot() {
            setDraft((current) => ({ ...current, roots: [...current.roots, ""] }));
        }

        function removeRoot(index) {
            setDraft((current) => ({
                ...current,
                roots: current.roots.filter((_, at) => at !== index),
            }));
        }

        function updateLimit(key, value) {
            setDraft((current) => ({
                ...current,
                limits: { ...current.limits, [key]: value },
            }));
        }

        function updateLayer(key, value) {
            setDraft((current) => ({
                ...current,
                toolLayer: { ...current.toolLayer, [key]: value },
            }));
        }

        function save() {
            try {
                void send("save", buildSettings(draft));
            } catch (failure) {
                setMessage({ kind: "error", text: failure.message });
            }
        }

        function ask(action, text) {
            setConfirming({ action, text });
        }

        function confirmInline() {
            const action = confirming?.action;

            setConfirming(null);

            if (action) {
                void send(action);
            }
        }

        if (!view || !draft) {
            return html`<div class="ops-config">
                ${
                    message
                        ? html`<div class="error-box" role="alert">${message.text}</div>`
                        : html`<${pocket.Loader} label="读取 Ops 配置" />`
                }
            </div>`;
        }

        const configured = view.config !== null;
        const hostVersion = view.hostVersion || pocket.pocketVersion || "未取得";
        const layerOn = view.config?.toolLayer.enabled === true;
        const configTone = view.disabled ? "warn" : view.active ? "ok" : "err";
        const configLabel = view.disabled
            ? "配置已禁用（fail closed）"
            : view.active
              ? "配置生效"
              : "配置无效 / 未配置";
        const write = view.capabilities.write === true;

        return html`<div class="ops-config">
            <header class="ops-head">
                <div>
                    <h2>Ops 配置</h2>
                    <p class="ops-note">
                        Ops ${view.opsVersion} + 配置 UI ${view.configUiVersion} · Pi Pocket
                        ${hostVersion}
                    </p>
                </div>
                <div class="ops-chips">
                    <span class="ops-chip ok">扩展已加载</span>
                    <span class=${`ops-chip ${configTone}`}>${configLabel}</span>
                    <span class=${`ops-chip ${layerOn ? "ok" : "warn"}`}
                        >${layerOn ? "去重层开启" : "去重层关闭"}</span
                    >
                </div>
            </header>

            <div class="ops-msg warn">
                扩展关：本页与路由不可用。Doc disabled：ops 工具 fail closed，内置 read 直通。
                layer.enabled=false：已装运行行为失效/直通，不是卸载
                wraps/hook；扩展、路由和七个工具仍可用。
            </div>

            ${view.reason ? html`<div class="ops-msg warn">${view.reason}</div>` : null}
            ${
                write
                    ? null
                    : html`<div class="ops-msg warn">
                          ${view.capabilities.reason || "页面只读"}
                      </div>`
            }
            ${
                message
                    ? html`<div class=${`ops-msg ${message.kind}`} role="status">
                          ${message.text}
                      </div>`
                    : null
            }

            <section class="ops-card">
                <h3>状态</h3>
                <div class="ops-kv">
                    <span>来源</span><span class="mono">${sourceText(view)}</span>
                    <span>配置文档</span><span class="mono">x.pi-pocket-ops.config</span>
                    <span>版本</span><span class="mono">${view.uiVersion}</span>
                </div>
            </section>

            <section class="ops-card">
                <h3>覆盖与边界</h3>
                <p class="ops-note">
                    已实现：只读相对路径工具 ops_read / ops_search / ops_check / ops_batch /
                    ops_result；显式批量写入 ops_write / ops_edit（1..8 文件、无 Ops 自设审批、
                    宿主正常钩子仍生效；逐文件结果，任何失败整批回滚并明确列出；不替换原生
                    write/edit）；allowedRoots、limits 预算、分页 handles、去重与内置 read
                    包装层。保存后下一次调用生效，进行中的旧调用按旧运行时完成。
                </p>
                <p class="ops-note">
                    不覆盖：绝对路径、shell 执行命令、网络与子进程；原生 write/edit 保持不变，Ops
                    不接管；Gate / Role 策略边界（独立模块，本页不重做）；Pi Pocket
                    核心。查询/命令输出治理只复用现有 toolLayer.enabled 与 limits
                    预算，没有独立开关。
                </p>
            </section>

            <section class="ops-card">
                <h3>允许的根目录（allowedRoots）</h3>
                <p class="ops-note">
                    仅 Owner 的本页可改；服务端用原 loadConfig
                    复验：必须是绝对、规范化、无符号链接的真实目录；home、.ssh、凭据与系统目录永拒。空白行会被忽略。
                </p>
                <div class="ops-roots">
                    ${draft.roots.map(
                        (root, index) =>
                            html`<div class="ops-root" key=${index}>
                                <input
                                    type="text"
                                    spellcheck="false"
                                    autocomplete="off"
                                    placeholder="/absolute/real/directory"
                                    value=${root}
                                    disabled=${!write}
                                    onInput=${(event) => updateRoot(index, event.currentTarget.value)}
                                />
                                <button
                                    class="button"
                                    type="button"
                                    disabled=${!write || draft.roots.length <= 1}
                                    onClick=${() => removeRoot(index)}
                                >
                                    移除
                                </button>
                            </div>`,
                    )}
                </div>
                <div class="ops-actions">
                    <button class="button" type="button" disabled=${!write} onClick=${addRoot}>
                        添加根目录
                    </button>
                </div>
            </section>

            <section class="ops-card">
                <h3>限额（limits）</h3>
                ${
                    configured
                        ? html`<div class="ops-grid">
                              ${LIMIT_FIELDS.map(
                                  (field) =>
                                      html`<div class="ops-field" key=${field.key}>
                                          <label for=${`ops-limit-${field.key}`}
                                              >${field.label}</label
                                          >
                                          <input
                                              id=${`ops-limit-${field.key}`}
                                              type="text"
                                              inputmode="numeric"
                                              value=${draft.limits[field.key] ?? ""}
                                              disabled=${!write}
                                              onInput=${(event) =>
                                                  updateLimit(field.key, event.currentTarget.value)}
                                          />
                                          <span class="ops-note mono">${field.key}</span>
                                      </div>`,
                              )}
                          </div>`
                        : html`<p class="ops-note">
                              还没有通过校验的配置。先填写并保存至少一个合法根目录；服务端会用原默认值补全
                              limits 与 toolLayer，然后这里变为可编辑。
                          </p>`
                }
            </section>

            <section class="ops-card">
                <h3>包装与去重层（toolLayer）</h3>
                ${
                    configured
                        ? html`<div class="ops-grid">
                                  <div class="ops-field">
                                      <label>运行层 enabled</label>
                                      <${pocket.Switch}
                                          on=${draft.toolLayer.enabled === true}
                                          label="去重与包装层"
                                          disabled=${!write}
                                          onChange=${() =>
                                              updateLayer(
                                                  "enabled",
                                                  draft.toolLayer.enabled !== true,
                                              )}
                                      />
                                      <span class="ops-note"
                                          >关闭后已装运行行为失效/直通，不是卸载
                                          wraps/hook；七个工具仍可用。</span
                                      >
                                  </div>
                                  <div class="ops-field">
                                      <label for="ops-dedup">dedup</label>
                                      <select
                                          id="ops-dedup"
                                          value=${draft.toolLayer.dedup ?? "off"}
                                          disabled=${!write}
                                          onChange=${(event) =>
                                              updateLayer("dedup", event.currentTarget.value)}
                                      >
                                          <option value="off">off</option>
                                          <option value="audit">audit</option>
                                          <option value="soft">soft</option>
                                      </select>
                                  </div>
                                  <div class="ops-field">
                                      <label for="ops-builtin">builtinRead</label>
                                      <select
                                          id="ops-builtin"
                                          value=${draft.toolLayer.builtinRead ?? "off"}
                                          disabled=${!write}
                                          onChange=${(event) =>
                                              updateLayer("builtinRead", event.currentTarget.value)}
                                      >
                                          <option value="off">off</option>
                                          <option value="audit">audit</option>
                                          <option value="soft">soft</option>
                                      </select>
                                  </div>
                                  ${LAYER_NUMBER_FIELDS.map(
                                      (field) =>
                                          html`<div class="ops-field" key=${field.key}>
                                              <label for=${`ops-layer-${field.key}`}
                                                  >${field.label}</label
                                              >
                                              <input
                                                  id=${`ops-layer-${field.key}`}
                                                  type="text"
                                                  inputmode="numeric"
                                                  value=${draft.toolLayer[field.key] ?? ""}
                                                  disabled=${!write}
                                                  onInput=${(event) =>
                                                      updateLayer(
                                                          field.key,
                                                          event.currentTarget.value,
                                                      )}
                                              />
                                              <span class="ops-note mono"
                                                  >toolLayer.${field.key}</span
                                              >
                                          </div>`,
                                  )}
                              </div>
                              <p class="ops-note">
                                  查询与 codemode 的输出治理沿用这些 enabled / limits
                                  值，没有本页单独的开关。
                              </p>`
                        : html`<p class="ops-note">保存一份有效根目录后才可编辑分层。</p>`
                }
            </section>

            <section class="ops-card">
                <h3>写入</h3>
                <p class="ops-note">
                    所有写入只改 x.pi-pocket-ops.config，必须带当前 revision 做 CAS；冲突返回 409
                    且不覆盖旧配置。未知字段、越界数值、未通过 loadConfig 的路径都会拒绝。
                </p>
                <div class="ops-actions">
                    <button
                        class="button primary"
                        type="button"
                        disabled=${busy || !write}
                        onClick=${save}
                    >
                        ${busy ? "处理中…" : "保存配置"}
                    </button>
                    <button
                        class="button"
                        type="button"
                        disabled=${busy || !write}
                        onClick=${() => void reload(false)}
                    >
                        刷新
                    </button>
                    ${
                        view.disabled
                            ? html`<button
                                  class="button"
                                  type="button"
                                  disabled=${busy || !write}
                                  onClick=${() => void send("enable")}
                              >
                                  启用
                              </button>`
                            : html`<button
                                  class="button"
                                  type="button"
                                  disabled=${busy || !write}
                                  onClick=${() =>
                                      ask(
                                          "disable",
                                          "禁用后 ops 工具 fail closed，内置 read 直通；保留当前 JSON。",
                                      )}
                              >
                                  禁用
                              </button>`
                    }
                    <button
                        class="button"
                        type="button"
                        disabled=${busy || !write || !configured}
                        onClick=${() =>
                            ask(
                                "defaults",
                                "仅将 limits 与 toolLayer 恢复为服务端已校验的默认值；保留 allowedRoots 与 disabled 状态。",
                            )}
                    >
                        恢复默认
                    </button>
                    <button
                        class="button"
                        type="button"
                        disabled=${busy || !write}
                        onClick=${() =>
                            ask(
                                "clear",
                                "清空配置文档 JSON，回到环境变量回退；保留 disabled 状态，不扩大任何根目录。",
                            )}
                    >
                        清除配置 JSON
                    </button>
                </div>
                ${
                    confirming
                        ? html`<div class="ops-confirm" role="alertdialog" aria-label="确认操作">
                              <span>${confirming.text}</span>
                              <div class="ops-actions">
                                  <button
                                      class="button primary"
                                      type="button"
                                      disabled=${busy}
                                      onClick=${confirmInline}
                                  >
                                      确认${
                                          confirming.action === "disable"
                                              ? "禁用"
                                              : confirming.action === "defaults"
                                                ? "恢复默认"
                                                : "清除"
                                      }
                                  </button>
                                  <button
                                      class="button"
                                      type="button"
                                      onClick=${() => setConfirming(null)}
                                  >
                                      取消
                                  </button>
                              </div>
                          </div>`
                        : null
                }
            </section>

            <p class="ops-note">
                ${view.defaultsReason ?? "默认值由服务端用同一 loadConfig 派生，不在浏览器里硬编码。"}
            </p>
        </div>`;
    }

    pocket.page({
        id: "ops-settings",
        title: "Ops 配置",
        component: OpsSettings,
    });
    pocket.menu({
        id: "ops-settings",
        label: "Ops 配置",
        hint: "只读边界",
        page: "ops-settings",
    });
}
