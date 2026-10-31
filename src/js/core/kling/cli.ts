/**
 * 可灵 CLI 调用封装（Node 层）
 *
 * 与 RocX（UXP 版）的关键差异：
 *   UXP 侧靠 C++ Hybrid Addon 的 runCommand 起进程；CEP 侧直接用 Node 的
 *   child_process.execFile，**整条 CMake 编译链删除**。
 *
 * 为什么要自己定位「系统 node」而不是直接跑 `kling`：
 *   `kling` 是 `#!/usr/bin/env node` 的 shebang 脚本（npm 全局安装的软链）。
 *   Premiere 从 Dock 启动时继承精简 PATH，既没有 npm 全局 bin 目录，
 *   常常也没有 node —— 直接执行会得到 `env: node: No such file or directory`。
 *   所以这里定位「node 可执行文件绝对路径」+「CLI 的 JS 入口绝对路径」，
 *   用 node 直接跑 JS 入口，绕开 PATH 与 shebang。
 *
 * ⚠ CEP 内嵌的 Node 不是独立 node 二进制，不能拿来运行 CLI（见 docs 第 1 节），
 *   所以必须找系统里装的 node。
 */
import { child_process, fs, os, path } from "../../lib/cep/node";
import type { KlingCliCode, KlingCliExecResult, KlingCliPriority } from "../../../shared/types";

/** 一次进程执行的结果 */
export interface RunResult {
  ok: boolean;
  exitCode: number;
  out: string;
  err: string;
  timedOut: boolean;
}

/** 已定位好的 CLI 执行入口 */
export interface CliEntry {
  /** node 可执行文件绝对路径 */
  nodePath: string;
  /** 可灵 CLI 的 JS 入口绝对路径 */
  cliJs: string;
  /** CLI 自报版本 */
  version?: string;
  /** npm 全局包根（含 @klingai 的那一层） */
  npmRoot: string;
}

/** CLI 顶层信封：{ ok, status, body } */
interface KlingEnvelope<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
}

/** 同时存活的 CLI 业务进程数上限 */
const MAX_CONCURRENT_CLI = 3;

/** 排队等待的最长时间（毫秒）—— 超过则放弃并报错 */
let QUEUE_WAIT_TIMEOUT_MS = 30000;

/** npm 包名（国内站 / 海外站） */
export const KLING_PACKAGE_CN = "@klingai/cli-cn";
export const KLING_PACKAGE_GLOBAL = "@klingai/cli-global";

// ---------- 平台与进程 ----------

function isWindows(): boolean {
  try {
    return os.platform() === "win32";
  } catch {
    return false;
  }
}

function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

/** Node 环境是否可用（CEP 未开 --enable-nodejs 时为 false） */
export function isNodeAvailable(): boolean {
  return !!(child_process && typeof child_process.execFile === "function");
}

// ---------- 环境块净化（Windows spawn ENOMEM 对策） ----------

/**
 * 为什么需要净化：
 *   Windows 版 Premiere 里点「一键安装」报 `spawn ENOMEM`，
 *   但同一命令在系统终端 2 秒装完；系统内存明明充足。
 *   结论：不是内存不足，是 CEP 内嵌 Node（旧 libuv）在 Windows 上
 *   创建子进程时对「从宿主继承来的环境块」非常敏感：
 *     - `process.env` 里混有 `=C:` / `=D:` 这类隐藏变量（键名以 '=' 开头），
 *       旧版 libuv 序列化环境块时不剔除，CreateProcess 直接失败；
 *     - PR 继承的环境块可能超长（Windows 环境块上限 32767 字符）。
 *   两种情况都被 libuv 映射成 UV_ENOMEM，于是看到误导性的 "spawn ENOMEM"。
 *
 * 对策分两档：
 *   1) 首次 spawn：剔除非法键与超长值后照常执行；
 *   2) 仍报 ENOMEM/E2BIG：改用「最小安全环境」重试一次
 *      （只保留进程创建必需的变量 + PATH）。
 */

/** 判断一次 spawn 失败是否疑似环境块问题 */
function looksLikeSpawnEnvFailure(err: any): boolean {
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
  if (code === "ENOMEM" || code === "E2BIG" || code === "ENOBUFS") return true;
  const msg = String((err as any).message || err);
  return /spawn\s+(ENOMEM|E2BIG|ENOBUFS)/i.test(msg);
}

/** 最小安全环境要保留的键（Windows） */
const WIN_SAFE_ENV_KEYS = [
  "PATH", "Path",
  "SystemRoot", "SystemDrive", "windir", "WINDIR", "ComSpec", "COMSPEC",
  "TEMP", "TMP", "PATHEXT",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS", "OS", "PROCESSOR_ARCHITECTURE", "USERDOMAIN",
];

/** 最小安全环境要保留的键（macOS） */
const POSIX_SAFE_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME",
];

/** 构造最小安全环境：只保留子进程定位可执行文件与读写用户目录所需变量 */
function buildSafeEnv(): Record<string, string> {
  const src = (process.env || {}) as unknown as Record<string, string>;
  const out: Record<string, string> = {};
  const keys = isWindows() ? WIN_SAFE_ENV_KEYS : POSIX_SAFE_ENV_KEYS;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.length) out[k] = v;
  }
  if (isWindows()) {
    if (!out.PATH && !out.Path) out.Path = "C:\\Windows\\System32;C:\\Windows";
    if (!out.SystemRoot) out.SystemRoot = "C:\\Windows";
    if (!out.ComSpec) out.ComSpec = "C:\\Windows\\System32\\cmd.exe";
    const home = homeDir();
    if (!out.TEMP && home) out.TEMP = path.join(home, "AppData", "Local", "Temp");
    if (!out.TMP && home) out.TMP = out.TEMP;
  } else if (!out.PATH) {
    out.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  return out;
}

/** 净化环境块：剔除空键名 / '=' 开头的隐藏变量 / 超长值 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env || {})) {
    if (!k || k.charCodeAt(0) === 61) continue; // '=' 开头（=C: 等隐藏变量）
    const v = (env as any)[k];
    if (typeof v !== "string" || !v.length) continue;
    if (v.length > 16384) continue; // 单条超长值直接丢弃（防环境块超限）
    out[k] = v;
  }
  return out;
}

/**
 * 起一个子进程并收集输出。
 *
 * 不用 shell（execFile 而非 exec）—— 命令参数全部以数组下发，
 * 用户输入（提示词 / 路径）不会进入 shell 解析，天然免疫命令注入。
 *
 * 环境块策略：传入的环境先净化；若 Windows 下报 ENOMEM/E2BIG，
 * 自动用最小安全环境重试一次（见上方「环境块净化」注释）。
 */
export function runProcess(
  exe: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!isNodeAvailable()) {
      resolve({
        ok: false,
        exitCode: -1,
        out: "",
        err: "Node 环境不可用（CEP 未启用 --enable-nodejs）",
        timedOut: false,
      });
      return;
    }
    let settled = false;
    let usedSafeEnv = false;
    const finish = (r: RunResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const attempt = (env: Record<string, string> | undefined) => {
      try {
        child_process.execFile(
          exe,
          args,
          {
            timeout: opts.timeoutMs ?? 60000,
            maxBuffer: 32 * 1024 * 1024,
            cwd: opts.cwd,
            env,
            windowsHide: true,
          },
          (err: any, stdout: string, stderr: string) => {
            // 超时被杀的进程不算环境块失败，不重试
            const isKill = !!(err && (err.killed || err.signal));
            if (err && !isKill && !usedSafeEnv && looksLikeSpawnEnvFailure(err)) {
              usedSafeEnv = true;
              attempt(buildSafeEnv());
              return;
            }
            const timedOut = !!(err && (err.killed || err.signal === "SIGTERM"));
            const exitCode =
              err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            finish({
              ok: !err,
              exitCode,
              out: stdout || "",
              err: stderr || (err ? String(err.message || err) : ""),
              timedOut,
            });
          },
        );
      } catch (e: any) {
        if (!usedSafeEnv && looksLikeSpawnEnvFailure(e)) {
          usedSafeEnv = true;
          attempt(buildSafeEnv());
          return;
        }
        finish({
          ok: false,
          exitCode: -1,
          out: "",
          err: String(e?.message || e),
          timedOut: false,
        });
      }
    };
    attempt(opts.env ? sanitizeEnv(opts.env) : undefined);
  });
}

// ---------- 定位系统 node ----------

/** node 可执行文件名 */
function nodeExeName(): string {
  return isWindows() ? "node.exe" : "node";
}

/**
 * 判断某个路径下是否有一个可执行的 node。
 *
 * 只查「存在 + 是文件」；不执行 --version（探测阶段已经够了，
 * 真正要跑的时候自然会失败并被上层分类）。
 */
function hasNodeAt(p: string): boolean {
  try {
    if (!p) return false;
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 定位系统 node 的绝对路径。
 *
 * 顺序：
 *   1. 进程 PATH 里的 node（最常见）
 *   2. 常见安装位置（Homebrew / 官方安装包 / nvm / volta / fnm）
 *   3. login shell 里的 `command -v node`
 *      —— PR 从 Dock 启动时 PATH 被精简，但 login shell 会执行
 *      /etc/zprofile 的 path_helper 恢复完整 PATH（这是 UXP 侧验证过的结论）
 */
export async function locateSystemNode(): Promise<string> {
  // 1) 当前进程 PATH
  try {
    const raw = process.env?.PATH || process.env?.Path || "";
    for (const dir of raw.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, nodeExeName());
      if (hasNodeAt(candidate)) return candidate;
    }
  } catch {
    // ignore
  }

  // 2) 常见安装位置
  const home = homeDir();
  const candidates: string[] = isWindows()
    ? [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
        home ? path.join(home, "AppData", "Roaming", "nvm", "current", "node.exe") : "",
        home ? path.join(home, "AppData", "Local", "Programs", "nodejs", "node.exe") : "",
      ]
    : [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        home ? path.join(home, ".volta", "bin", "node") : "",
        home ? path.join(home, ".local", "bin", "node") : "",
      ];
  for (const c of candidates) {
    if (hasNodeAt(c)) return c;
  }

  // 2b) nvm / fnm 这类「多版本目录」：取版本号最大的一个
  if (!isWindows() && home) {
    const multiRoots = [
      path.join(home, ".nvm", "versions", "node"),
      path.join(home, ".fnm", "node-versions"),
    ];
    for (const root of multiRoots) {
      try {
        if (!fs.existsSync(root)) continue;
        const versions = fs
          .readdirSync(root)
          .filter((v) => fs.existsSync(path.join(root, v)))
          .sort()
          .reverse();
        for (const v of versions) {
          const p = path.join(root, v, "bin", "node");
          if (hasNodeAt(p)) return p;
          const pWin = path.join(root, v, "node.exe");
          if (hasNodeAt(pWin)) return pWin;
        }
      } catch {
        // ignore
      }
    }
  }

  // 3) login shell
  const viaShell = await locateNodeViaShell();
  if (viaShell) return viaShell;

  return "";
}

/** 通过 login shell 找 node（恢复被精简的 PATH） */
async function locateNodeViaShell(): Promise<string> {
  if (isWindows()) {
    const r = await runProcess(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "where node"],
      { timeoutMs: 15000 },
    );
    const line = (r.out || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".exe"));
    return line || "";
  }
  const attempts = [
    { exe: "/bin/zsh", args: ["-l", "-c", "command -v node"] },
    { exe: "/bin/sh", args: ["-l", "-c", "command -v node"] },
  ];
  for (const attempt of attempts) {
    const r = await runProcess(attempt.exe, attempt.args, { timeoutMs: 15000 });
    const line = (r.out || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.startsWith("/") && s.endsWith("node"));
    if (line) return line;
  }
  return "";
}

/** node 版本号（用于校验 CLI 要求的 ≥ 18） */
export async function readNodeVersion(nodePath: string): Promise<string> {
  const r = await runProcess(nodePath, ["--version"], { timeoutMs: 10000 });
  return (r.out || "").trim();
}

// ---------- 定位 npm 全局包根 ----------

/**
 * 定位 npm 全局包根（含 @klingai 的那一层）。
 *
 * 优先用 node 直接跑 npm 自带的 npm-cli.js（不要求 `npm` 本身在 PATH 里 ——
 * npm 同样是 shebang 脚本，PATH 精简时同样跑不起来）。
 */
export async function locateNpmRoots(
  nodePath: string,
): Promise<string[]> {
  const roots: string[] = [];
  const nodeDir = path.dirname(nodePath);

  const npmCliCandidates = isWindows()
    ? [path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")]
    : [path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];

  for (const npmCli of npmCliCandidates) {
    if (!fs.existsSync(npmCli)) continue;
    const r = await runProcess(nodePath, [npmCli, "root", "-g"], {
      timeoutMs: 20000,
    });
    const out = (r.out || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (out) roots.push(out);
    break;
  }

  // 兜底候选
  if (!isWindows()) {
    roots.push(path.join(nodeDir, "..", "lib", "node_modules"));
    const home = homeDir();
    if (home) roots.push(path.join(home, ".npm-global", "lib", "node_modules"));
  } else {
    const appdata = process.env?.APPDATA || "";
    if (appdata) roots.push(path.join(appdata, "npm", "node_modules"));
    // Windows 下降级安装（--prefix ~/.npm-global）的布局没有 lib/ 一层
    const home = homeDir();
    if (home) roots.push(path.join(home, ".npm-global", "node_modules"));
  }

  // 去重（保持顺序）
  return roots.filter((r, i) => !!r && roots.indexOf(r) === i);
}

/** 可灵 CLI 在 npm 全局包里的相对路径 */
function cliJsCandidates(npmRoot: string): string[] {
  const sep = isWindows() ? "\\" : "/";
  return [
    [npmRoot, "@klingai", "cli-cn", "dist", "cli.js"].join(sep),
    [npmRoot, "@klingai", "cli-global", "dist", "cli.js"].join(sep),
  ];
}

/**
 * 定位可灵 CLI 的执行入口（node + cli.js）。
 * 找不到返回 null。
 */
async function locateCliEntry(): Promise<CliEntry | null> {
  const nodePath = await locateSystemNode();
  if (!nodePath) return null;

  const roots = await locateNpmRoots(nodePath);
  for (const root of roots) {
    for (const cliJs of cliJsCandidates(root)) {
      if (!fs.existsSync(cliJs)) continue;
      const probe = await runProcess(nodePath, [cliJs, "--version"], {
        timeoutMs: 20000,
      });
      if (!probe.ok && !probe.out) continue;
      return {
        nodePath,
        cliJs,
        version: (probe.out || "").trim() || undefined,
        npmRoot: root,
      };
    }
  }
  return null;
}

/** CLI 入口定位结果缓存（失败不缓存，允许用户装好后立即重试） */
let entryPromise: Promise<CliEntry | null> | null = null;

/** 取得（并缓存）CLI 入口 */
export async function getCliEntry(): Promise<CliEntry | null> {
  if (!entryPromise) {
    entryPromise = locateCliEntry().catch(() => null);
  }
  const entry = await entryPromise;
  if (!entry) entryPromise = null;
  return entry;
}

/** 仅测试 / 重新检测用：清空入口缓存 */
export function resetCliCache(): void {
  entryPromise = null;
}

// ---------- 并发限流 ----------

/**
 * 为什么限流：每次 CLI 调用都会 fork 一个独立 node 进程，
 * 单进程峰值 RSS 实测 300MB+（node 要加载 CLI 那份大产物 + 上百个依赖）。
 * 16 个并发实测吃掉 2.2GB 内存，在 Premiere 里再叠加渲染会明显卡顿。
 *
 * 限流点选在**真正要起进程之前**：定位 node / npm root 那些探测步骤
 * 只在首次定位时跑一次，不必纳入业务限流。
 */

/** 当前在跑的进程数 */
let runningCount = 0;

/** 等待中的队列条目 */
interface WaitEntry {
  resolve: (ok: boolean) => void;
  timer: any;
  settled: boolean;
}

/** 等待中的队列（前台优先，后台次之；同优先级内先进先出） */
const fgQueue: WaitEntry[] = [];
const bgQueue: WaitEntry[] = [];

/**
 * 取得一个执行槽位。
 *
 * 后台任务（预上传）不抢占排队中的前台请求 —— 否则用户点「生成」时
 * 槽位可能被预上传占满，提交被迫排队。
 */
async function acquireSlot(priority: KlingCliPriority): Promise<boolean> {
  if (runningCount < MAX_CONCURRENT_CLI) {
    if (priority === "background" && fgQueue.length > 0) {
      // 前台在等 → 后台进队列
    } else {
      runningCount++;
      return true;
    }
  }
  return await new Promise<boolean>((resolve) => {
    const queue = priority === "foreground" ? fgQueue : bgQueue;
    const entry: WaitEntry = {
      resolve: (ok: boolean) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.timer) clearTimeout(entry.timer);
        resolve(ok);
      },
      timer: null,
      settled: false,
    };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      resolve(false);
    }, QUEUE_WAIT_TIMEOUT_MS);
    queue.push(entry);
  });
}

/** 释放槽位；若有等待者则直接交接给它（保持并发数不变），前台优先 */
function releaseSlot(): void {
  const next = fgQueue.shift() || bgQueue.shift();
  if (next) {
    next.resolve(true);
  } else {
    runningCount = Math.max(0, runningCount - 1);
  }
}

/** 当前限流状态（诊断用） */
export function getKlingCliConcurrencyState(): {
  running: number;
  queued: number;
  max: number;
} {
  return {
    running: runningCount,
    queued: fgQueue.length + bgQueue.length,
    max: MAX_CONCURRENT_CLI,
  };
}

// ---------- 执行 ----------

/** 从文本判断是否为「未登录」 */
export function looksLikeNotLoggedIn(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("登录态") ||
    t.includes("access_token") ||
    t.includes("kling login") ||
    t.includes("not logged in") ||
    t.includes("unauthorized") ||
    t.includes("no valid login")
  );
}

/**
 * 执行一条可灵 CLI 命令。
 *
 * @param args CLI 子命令 + 参数（如 ["who_am_i", "--quiet"]）
 * @param opts.timeoutMs 超时（默认 60s）
 * @param opts.priority 优先级（默认 foreground；预上传等后台任务用 background）
 */
export async function execKlingCli(
  args: string[],
  opts?: { timeoutMs?: number; priority?: KlingCliPriority },
): Promise<KlingCliExecResult> {
  if (!isNodeAvailable()) {
    return {
      ok: false,
      code: "node_not_found",
      error: "Node 环境不可用：CEP 未启用 --enable-nodejs，无法调用可灵 CLI。",
    };
  }

  const entry = await getCliEntry();
  if (!entry) {
    return {
      ok: false,
      code: "cli_not_installed",
      error:
        "未找到可灵 CLI。请先安装：国内站 npm i -g @klingai/cli-cn，海外站 npm i -g @klingai/cli-global。",
    };
  }

  const gotSlot = await acquireSlot(opts?.priority ?? "foreground");
  if (!gotSlot) {
    return {
      ok: false,
      code: "command_failed",
      error: `可灵 CLI 请求排队超时（等待超过 ${Math.round(
        QUEUE_WAIT_TIMEOUT_MS / 1000,
      )}s）。请稍后重试。`,
    };
  }

  let r: RunResult;
  try {
    r = await runProcess(entry.nodePath, [entry.cliJs, ...args], {
      timeoutMs: opts?.timeoutMs ?? 60000,
      env: process.env as unknown as Record<string, string>,
    });
  } catch (e: any) {
    releaseSlot();
    return {
      ok: false,
      code: "command_failed",
      error: `执行可灵 CLI 异常: ${e?.message || e}`,
    };
  }
  releaseSlot();

  if (r.timedOut) {
    return {
      ok: false,
      code: "timeout",
      error: "可灵 CLI 执行超时。",
      raw: r.out,
    };
  }

  const stdout = (r.out || "").trim();

  // stdout 为空：CLI 走了 stderr 报错路径（AuthError 等）
  if (!stdout) {
    const stderr = (r.err || "").trim();
    if (looksLikeNotLoggedIn(stderr)) {
      return {
        ok: false,
        code: "not_logged_in",
        error: `可灵 CLI 未登录。请先执行 \`kling login\` 完成登录。${stderr}`,
      };
    }
    return {
      ok: false,
      code: "command_failed",
      error: stderr || `可灵 CLI 执行失败（exit ${r.exitCode}）。`,
    };
  }

  // stdout 非 JSON
  let envelope: KlingEnvelope;
  try {
    envelope = JSON.parse(stdout) as KlingEnvelope;
  } catch {
    return {
      ok: false,
      code: "bad_output",
      error: "可灵 CLI 输出不是合法 JSON。",
      raw: stdout,
    };
  }

  // 业务失败（envelope.ok === false）：body 可能是字符串或对象
  if (!envelope.ok) {
    const bodyText =
      typeof envelope.body === "string"
        ? envelope.body
        : JSON.stringify(envelope.body ?? "");
    if (looksLikeNotLoggedIn(bodyText)) {
      return {
        ok: false,
        code: "not_logged_in",
        error: `可灵 CLI 未登录。请先执行 \`kling login\` 完成登录。${bodyText}`,
        raw: stdout,
      };
    }
    return {
      ok: false,
      code: "command_failed",
      error: bodyText || `可灵 CLI 返回失败（status ${envelope.status}）。`,
      raw: stdout,
    };
  }

  return {
    ok: true,
    code: "ok",
    data: envelope.body,
    raw: stdout,
  };
}

/**
 * 以「后台进程」方式启动一条 CLI 命令（不等待结束）。
 *
 * 用于 `kling login`：OAuth 流程会拉起浏览器并在本地回环端口等待授权，
 * 面板这边只需要把输出透给用户看。
 */
export async function spawnKlingCli(
  args: string[],
  onOutput?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const entry = await getCliEntry();
  if (!entry) {
    return {
      ok: false,
      error:
        "未找到可灵 CLI。请先安装：国内站 npm i -g @klingai/cli-cn，海外站 npm i -g @klingai/cli-global。",
    };
  }
  if (!isNodeAvailable()) {
    return { ok: false, error: "Node 环境不可用（CEP 未启用 --enable-nodejs）。" };
  }
  let triedSafeEnv = false;
  const start = (env: Record<string, string>) => {
    try {
      const proc = child_process.spawn(entry.nodePath, [entry.cliJs, ...args], {
        env,
        windowsHide: true,
      });
      const forward = (chunk: any) => {
        if (!onOutput) return;
        const text = String(chunk || "");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onOutput(line.trim());
        }
      };
      proc.stdout?.on("data", forward);
      proc.stderr?.on("data", forward);
      proc.on("error", (e: any) => {
        // ENOMEM/E2BIG → 最小安全环境重试一次
        if (!triedSafeEnv && looksLikeSpawnEnvFailure(e)) {
          triedSafeEnv = true;
          start(buildSafeEnv());
          return;
        }
        onOutput?.(`启动失败: ${e?.message || e}`);
      });
    } catch (e: any) {
      if (!triedSafeEnv && looksLikeSpawnEnvFailure(e)) {
        triedSafeEnv = true;
        start(buildSafeEnv());
        return;
      }
      onOutput?.(`启动失败: ${e?.message || e}`);
    }
  };
  start(sanitizeEnv(process.env as unknown as Record<string, string>));
  return { ok: true };
}

/** 供 UI 展示用：把错误码翻译成一句人话 */
export function describeKlingCliCode(code: KlingCliCode): string {
  switch (code) {
    case "node_not_found":
      return "Node 环境不可用（CEP 未启用 --enable-nodejs）";
    case "cli_not_installed":
      return "未安装可灵 CLI";
    case "not_logged_in":
      return "可灵 CLI 未登录";
    case "bad_output":
      return "可灵 CLI 输出解析失败";
    case "timeout":
      return "可灵 CLI 执行超时";
    case "command_failed":
      return "可灵 CLI 执行失败";
    default:
      return "正常";
  }
}
