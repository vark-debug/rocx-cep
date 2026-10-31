import { useState, useSyncExternalStore } from "react";
import {
  getApiKey,
  getKlingEnv,
  getKlingModels,
  getSequenceInfoSnapshot,
  getWebhookConfig,
  imageProviderOptions,
  installKlingCli,
  isDryRun,
  listConfiguredProviders,
  logoutKling,
  refreshKlingEnvInBackground,
  saveWebhookConfig,
  setApiKey,
  setDryRun,
  startKlingLogin,
  subscribeGeneration,
  subscribeKlingState,
  testWebhookReport,
  videoProviderOptions,
} from "../../core/api";

/**
 * 需要 API Key 的 provider（video ∪ image 选项里去掉 kling）。
 * kling 走 CLI 登录，无 Key 概念，不进这张表。
 */
const API_KEY_PROVIDERS = (() => {
  const seen = new Map<string, string>();
  for (const o of [...videoProviderOptions(), ...imageProviderOptions()]) {
    if (o.id !== "kling") seen.set(o.id, o.label);
  }
  return [...seen].map(([id, label]) => ({ id, label }));
})();

/**
 * 设置面板（齿轮打开）
 *
 * 覆盖三种「提交了也白搭」的情况：CLI 没装、没登录、余额不足。
 * 之前这些常驻在面板顶部，占掉一行宝贵高度；现在收进抽屉。
 *
 * 另含 HTTP provider 的 API Key 管理（per-provider 存插件数据目录）
 * 与 dry-run 开关（无 Key 验证请求构造，对齐 UXP 版 __ROCX_DRY_RUN__）。
 */
export const SettingsPanel = () => {
  const env = useSyncExternalStore(subscribeKlingState, getKlingEnv);
  const models = useSyncExternalStore(subscribeKlingState, getKlingModels);
  const seq = useSyncExternalStore(subscribeGeneration, getSequenceInfoSnapshot);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [region, setRegion] = useState<"cn" | "global">("cn");

  // ---- API Key 管理（per-provider，存插件数据目录 api-keys.json）----
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(API_KEY_PROVIDERS.map((p) => [p.id, getApiKey(p.id)])),
  );
  const [configured, setConfigured] = useState<string[]>(() =>
    listConfiguredProviders(),
  );
  const [keyMsg, setKeyMsg] = useState("");
  // ---- dry-run 开关（面板重载后回到默认关，与 Node 层语义一致）----
  const [dryRun, setDryRunState] = useState(() => isDryRun());
  // ---- Webhook 配置 + 测试上报 ----
  const [whForm, setWhForm] = useState(() => getWebhookConfig());
  const [whSaving, setWhSaving] = useState(false);
  const [whSaved, setWhSaved] = useState(false);
  const [whTesting, setWhTesting] = useState(false);
  const [whMsg, setWhMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saveWebhook = () => {
    setWhSaving(true);
    setWhMsg(null);
    try {
      setWhForm(saveWebhookConfig(whForm));
      setWhSaved(true);
      window.setTimeout(() => setWhSaved(false), 2000);
    } catch (e: any) {
      setWhMsg({ ok: false, text: `配置保存失败：${String(e?.message || e)}` });
    } finally {
      setWhSaving(false);
    }
  };

  const saveKey = (id: string) => {
    const v = (keyDrafts[id] || "").trim();
    setApiKey(id, v);
    setConfigured(listConfiguredProviders());
    setKeyMsg(v ? `${id} API Key 已保存` : `${id} API Key 已清除`);
  };

  const runWebhookTest = async () => {
    setWhTesting(true);
    setWhMsg(null);
    try {
      const res = await testWebhookReport();
      setWhMsg({
        ok: res.ok,
        text: res.skipped
          ? "未配置 Webhook 地址：编辑 ~/.rocx-cep/config.json"
          : res.ok
            ? "测试上报成功，请到接收端（飞书多维表格等）核对数据"
            : `测试上报失败：${res.error}`,
      });
    } catch (e: any) {
      setWhMsg({ ok: false, text: `测试异常：${String(e?.message || e)}` });
    } finally {
      setWhTesting(false);
    }
  };

  const cliMissing = env.reason === "cli_not_installed";
  const notLoggedIn = env.reason === "not_logged_in";
  const checking = !!env.checking;
  const unknown = !checking && !env.checkedAt;

  const recheck = async () => {
    setBusy(true);
    try {
      await refreshKlingEnvInBackground();
    } finally {
      setBusy(false);
    }
  };

  const login = async () => {
    setBusy(true);
    setLog([]);
    try {
      await startKlingLogin((line) => setLog((prev) => [...prev, line]));
      await refreshKlingEnvInBackground();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await logoutKling();
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setLog([]);
    try {
      const r = await installKlingCli(region, (_stage, detail) =>
        setLog((prev) => [...prev, detail || ""]),
      );
      setLog((prev) => [
        ...prev,
        r.ok
          ? `安装成功${r.version ? `（${r.version}）` : ""}`
          : r.message || "安装失败",
      ]);
      if (r.ok) await refreshKlingEnvInBackground();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <div className="env-row">
        {checking ? (
          <span className="badge busy">检测中…</span>
        ) : (
          <>
            <span className={`badge ${env.ready ? "ok" : "warn"}`}>
              {env.ready ? "环境就绪" : unknown ? "环境未知" : "环境未就绪"}
            </span>
            <span className={`badge ${cliMissing ? "warn" : "ok"}`}>
              CLI{" "}
              {cliMissing
                ? "未安装"
                : unknown
                  ? "状态未知"
                  : env.cliSource === "bundled"
                    ? "已内置"
                    : "已安装"}
            </span>
            <span className={`badge ${notLoggedIn ? "warn" : "ok"}`}>
              {notLoggedIn ? "未登录" : unknown ? "状态未知" : "已登录"}
            </span>
          </>
        )}
        {typeof env.credits === "number" && (
          <span className="badge">灵感值 {env.credits}</span>
        )}
        {env.membershipDescription && (
          <span className="badge">{env.membershipDescription}</span>
        )}
        <span className="badge">模型 {models.length}</span>
      </div>

      {env.message && <div className="env-message">{env.message}</div>}

      {env.rechargeUrl && (
        <a
          className="env-link"
          href={env.rechargeUrl}
          onClick={(e) => {
            e.preventDefault();
            window.open(env.rechargeUrl, "_blank");
          }}
        >
          充值灵感值 →
        </a>
      )}

      <div className="env-actions">
        <button disabled={busy || checking} onClick={recheck}>
          {checking ? "检测中…" : "重新检测"}
        </button>
        {cliMissing && (
          <>
            <select
              value={region}
              onChange={(e) =>
                setRegion(e.target.value as "cn" | "global")
              }
            >
              <option value="cn">国内站</option>
              <option value="global">海外站</option>
            </select>
            <button disabled={busy} onClick={install}>
              安装可灵 CLI
            </button>
          </>
        )}
        {notLoggedIn ? (
          <button disabled={busy} onClick={login}>
            登录
          </button>
        ) : unknown ? null : (
          <button disabled={busy} onClick={logout}>
            退出登录
          </button>
        )}
      </div>

      <div className="env-foot">
        host API v{seq.hostApi ?? "旧版（需重启 Premiere）"}
        {seq.hasSequence && seq.fps ? ` · ${seq.fps} fps` : ""}
        {env.checkedAt && !checking
          ? ` · 上次检测 ${new Date(env.checkedAt).toLocaleString()}`
          : ""}
      </div>

      {/* HTTP provider 的 API Key 管理 */}
      <div className="apikey-section">
        <div className="apikey-title">API 服务（HTTP 直连）</div>
        {API_KEY_PROVIDERS.map((p) => (
          <div className="apikey-row" key={p.id}>
            <span className="apikey-label">{p.label}</span>
            <input
              className="apikey-input"
              type="password"
              placeholder="粘贴 API Key"
              value={keyDrafts[p.id] ?? ""}
              onChange={(e) =>
                setKeyDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
              }
              autoComplete="off"
            />
            <button
              className="apikey-save"
              type="button"
              onClick={() => saveKey(p.id)}
            >
              保存
            </button>
            <span
              className={`apikey-status${configured.includes(p.id) ? " ok" : ""}`}
            >
              {configured.includes(p.id) ? "已配置" : "未配置"}
            </span>
          </div>
        ))}
        <label className="dryrun-toggle" title="开启后提交被拦截：只构造并打印请求，不发生真实调用（无 Key 也能验证全链）">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              setDryRun(e.target.checked);
              setDryRunState(e.target.checked);
            }}
          />
          dry-run 模式（拦截提交，仅验证请求构造）
        </label>
        {keyMsg && <div className="apikey-msg">{keyMsg}</div>}
      </div>

      {/* Webhook 上报：配置（地址/令牌/剪辑师）+ 测试上报 */}
      <div className="apikey-section">
        <div className="apikey-title">Webhook 生成上报</div>
        <div className="apikey-hint">
          提交生成任务后自动上报（fire-and-forget）；配置存
          ~/.rocx-cep/config.json（0600）
        </div>
        <div className="apikey-row">
          <span className="apikey-label">Webhook 地址</span>
          <input
            className="apikey-input"
            type="text"
            placeholder="飞书多维表格自动化入参地址（http/https）"
            value={whForm.feishuWebhookUrl}
            onChange={(e) =>
              setWhForm((p) => ({ ...p, feishuWebhookUrl: e.target.value }))
            }
            autoComplete="off"
          />
        </div>
        <div className="apikey-row">
          <span className="apikey-label">Bearer 令牌</span>
          <input
            className="apikey-input"
            type="password"
            placeholder="可选，强烈建议（未开启时限流 1 次/秒）"
            value={whForm.feishuToken}
            onChange={(e) =>
              setWhForm((p) => ({ ...p, feishuToken: e.target.value }))
            }
            autoComplete="off"
          />
        </div>
        <div className="apikey-row">
          <span className="apikey-label">剪辑师名</span>
          <input
            className="apikey-input"
            type="text"
            placeholder="上报行「剪辑师」列（可选）"
            value={whForm.editorName}
            onChange={(e) =>
              setWhForm((p) => ({ ...p, editorName: e.target.value }))
            }
            autoComplete="off"
          />
        </div>
        <div className="webhook-btn-row">
          <button
            className="apikey-save webhook-test-btn"
            type="button"
            disabled={whSaving}
            onClick={() => void saveWebhook()}
          >
            {whSaving ? "保存中…" : whSaved ? "✓ 已保存" : "保存配置"}
          </button>
          <button
            className="apikey-save webhook-test-btn"
            type="button"
            disabled={whTesting}
            onClick={() => void runWebhookTest()}
            title="用固定样例打一次 Webhook，验证地址 / 令牌 / 表格字段映射"
          >
            {whTesting ? "测试中…" : "⚡ 测试上报"}
          </button>
        </div>
        {whMsg && (
          <div className={`apikey-msg${whMsg.ok ? "" : " err"}`}>{whMsg.text}</div>
        )}
      </div>

      {log.length > 0 && (
        <pre className="env-log">{log.filter(Boolean).join("\n")}</pre>
      )}
    </section>
  );
};
