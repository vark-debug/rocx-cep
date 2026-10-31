import { useState, useSyncExternalStore } from "react";
import {
  getKlingEnv,
  getKlingModels,
  getSequenceInfoSnapshot,
  installKlingCli,
  logoutKling,
  refreshKlingEnvInBackground,
  startKlingLogin,
  subscribeGeneration,
  subscribeKlingState,
} from "../../core/api";

/**
 * 设置面板（齿轮打开）
 *
 * 覆盖三种「提交了也白搭」的情况：CLI 没装、没登录、余额不足。
 * 之前这些常驻在面板顶部，占掉一行宝贵高度；现在收进抽屉。
 */
export const SettingsPanel = () => {
  const env = useSyncExternalStore(subscribeKlingState, getKlingEnv);
  const models = useSyncExternalStore(subscribeKlingState, getKlingModels);
  const seq = useSyncExternalStore(subscribeGeneration, getSequenceInfoSnapshot);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [region, setRegion] = useState<"cn" | "global">("cn");

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

      {log.length > 0 && (
        <pre className="env-log">{log.filter(Boolean).join("\n")}</pre>
      )}
    </section>
  );
};
