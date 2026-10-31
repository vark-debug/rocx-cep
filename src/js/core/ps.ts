/**
 * 打开 Photoshop（Node 层）
 *
 * UXP 版要靠 C++ Hybrid addon → launcher 脚本 → 系统关联三层兜底
 * （RocX psLauncher.ts）；CEP 的 panel 带 Node（--enable-nodejs），
 * `child_process` 直接调系统命令即可，不需要那些绕路。
 *
 *   macOS:  open -a "Adobe Photoshop" <file>
 *   Windows: cmd /c start "" <file>（走文件关联）
 */
import { child_process, fs } from "../lib/cep/node";

export interface OpenPsResult {
  ok: boolean;
  /** 实际命中的启动方式（诊断用） */
  method?: string;
  error?: string;
}

/** execFileSync 的超时（open 命令正常毫秒级，超时说明环境坏了） */
const OPEN_TIMEOUT_MS = 15000;

/**
 * 在 /Applications 与 ~/Applications 里找已安装的 Photoshop 应用名（macOS）。
 *
 * ⚠⚠ CEP 面板的 fs.readdirSync 对 .app bundle 会**剥掉 .app 后缀**返回
 *   （实测：/Applications 里列出 "Adobe Photoshop 2026"，
 *     而 stat "Adobe Photoshop 2026.app" 反而 ENOENT），
 *   所以匹配只认前缀，.app 有没有都行。
 */
function findPsAppName(): string | null {
  for (const root of ["/Applications", "~/Applications"]) {
    try {
      const names = fs.readdirSync(root) as string[];
      for (const n of names) {
        if (/^Adobe Photoshop/i.test(n)) {
          return n.replace(/\.app$/i, "");
        }
      }
    } catch {
      // 目录读不到就算了
    }
  }
  return null;
}

/**
 * 用 Photoshop 打开一个文件（异步，等 open 命令返回）。
 *
 * ⚠⚠ 实测踩过的两个坑：
 *
 *   1. **不要同步等待**（execFileSync）：PS 未运行时 open 会等它就绪
 *      再递交文件事件，冷启动 20~40s，同步等必然超时被杀 →
 *      走错「系统默认关联」兜底（文件被预览打开）。
 *
 *   2. **不要 spawn + detached**（fire-and-forget）：panel 环境里
 *      detached 子进程会立即死亡且无任何报错（stdio 已 ignore），
 *      PS 根本不会被拉起。spawnSync（不 detached）同一命令秒成。
 *
 * 所以用 execFile 异步等待：继承环境（同 spawnSync 成功路径）、
 * 不阻塞 UI、60s 超时足够熬过 PS 冷启动。
 * 应用名从磁盘扫出（必然存在），open 失败只剩环境异常一种。
 */
export function openInPhotoshop(localPath: string): Promise<OpenPsResult> {
  if (!localPath) return Promise.resolve({ ok: false, error: "缺少文件路径" });
  try {
    if (!fs.existsSync(localPath)) {
      return Promise.resolve({ ok: false, error: "文件不存在：" + localPath });
    }
  } catch (e: any) {
    return Promise.resolve({
      ok: false,
      error: "无法访问文件：" + String(e?.message || e),
    });
  }

  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try {
        // start 是 cmd 内建命令；第一个 "" 是窗口标题占位（路径带空格必须给）
        child_process.exec(
          `cmd /c start "" "${localPath}"`,
          { timeout: OPEN_TIMEOUT_MS },
          (err: Error | null) => {
            resolve(
              err
                ? { ok: false, error: "无法打开 Photoshop：" + String(err) }
                : { ok: true, method: "cmd start (file association)" },
            );
          },
        );
      } catch (e: any) {
        resolve({ ok: false, error: "无法打开 Photoshop：" + String(e?.message || e) });
      }
    });
  }

  // 主路径：扫出真实应用名（Adobe Photoshop 2026 等）
  const realName = findPsAppName();
  const candidates = realName ? [realName] : [];
  if (!realName) candidates.push("Adobe Photoshop");

  const tryOpen = (app: string): Promise<OpenPsResult | null> =>
    new Promise((resolve) => {
      try {
        child_process.execFile(
          "open",
          ["-a", app, localPath],
          { timeout: OPEN_TIMEOUT_MS * 4 }, // 60s：足够熬过 PS 冷启动
          (err: Error | null) => {
            if (err) console.warn("[ps] open -a 失败:", app, err);
            resolve(
              err ? null : { ok: true, method: `open -a "${app}"` },
            );
          },
        );
      } catch (e: any) {
        console.warn("[ps] open 执行异常:", e);
        resolve(null);
      }
    });

  return (async () => {
    for (const app of candidates) {
      const res = await tryOpen(app);
      if (res) return res;
    }
    // 兜底：系统默认关联（用户没装 PS 时会打开别的看图软件，可接受）
    return new Promise<OpenPsResult>((resolve) => {
      try {
        child_process.execFile(
          "open",
          [localPath],
          { timeout: OPEN_TIMEOUT_MS },
          (err: Error | null) => {
            resolve(
              err
                ? { ok: false, error: "无法打开 Photoshop：" + String(err) }
                : { ok: true, method: "open (system default)" },
            );
          },
        );
      } catch (e: any) {
        resolve({ ok: false, error: "无法打开 Photoshop：" + String(e?.message || e) });
      }
    });
  })();
}
