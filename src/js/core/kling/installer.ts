/**
 * 可灵 CLI 一键安装器（Node 层）
 *
 * 为什么需要它：
 *   可灵 CLI 是 npm 全局包，**不随插件分发**（`@klingai/cli-cn` 无 license，
 *   捆绑进 ZXP 属于未授权再分发）。所以插件只做「探测 + 引导安装」。
 *
 * 安装方式与源项目（RocX）保持一致：**用 node 直接跑 npm 自带的 npm-cli.js**
 * （`node <npm-cli.js> install -g @klingai/cli-cn`），而不是 `npm i -g`。
 *   原因：npm 同样是 `#!/usr/bin/env node` 的 shebang 脚本，
 *   Premiere 从 Dock 启动时继承精简 PATH，直接跑会得到
 *   `env: node: No such file or directory`。
 *
 * 降级方案：npm 全局 prefix（如 /usr/local）不可写时，
 * 装到 `~/.npm-global`（源项目已验证的降级路径，CLI 探测逻辑里已包含该候选）。
 */
import { fs, os, path } from "../../lib/cep/node";
import type { KlingRegion } from "../../../shared/types";
import {
  KLING_PACKAGE_CN,
  KLING_PACKAGE_GLOBAL,
  getCliEntry,
  locateSystemNode,
  readNodeVersion,
  resetCliCache,
  runProcess,
} from "./cli";

/** 区域 → npm 包名 */
export function klingPackageName(region: KlingRegion): string {
  return region === "global" ? KLING_PACKAGE_GLOBAL : KLING_PACKAGE_CN;
}

/** 降级安装用的用户级 prefix */
export function fallbackPrefix(): string {
  const home = (() => {
    try {
      return os.homedir();
    } catch {
      return "";
    }
  })();
  return home ? path.join(home, ".npm-global") : "";
}

/**
 * 找到 npm 自带的 npm-cli.js 绝对路径。
 *
 * npm 官方安装布局：
 *   - POSIX：<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js
 *   - Windows：<nodeDir>/node_modules/npm/bin/npm-cli.js
 * 另有一些发行版把 npm 装在 <nodeDir>/lib/node_modules/npm/ 下。
 */
export async function locateNpmCli(nodePath: string): Promise<string> {
  const nodeDir = path.dirname(nodePath);
  const candidates = [
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return "";
}

/** 安装结果 */
export interface InstallResult {
  ok: boolean;
  /** 人话提示（失败时必填） */
  message?: string;
  /** 实际使用的包名 */
  packageName?: string;
  /** 实际使用的 prefix（降级安装时是 ~/.npm-global） */
  prefix?: string;
  /** 安装后探测到的 CLI 版本 */
  version?: string;
}

/** 安装进度回调（用于把长耗时过程透给 UI） */
export type InstallProgress = (stage: string, detail?: string) => void;

/** npm 输出里表示「权限不足」的关键词 */
function looksLikePermissionError(text: string): boolean {
  const t = (text || "").toLowerCase();
  // 注意：不要匹配裸的 "err!" —— npm 的任何报错（网络、404、EBUSY…）都带
  // "npm err!" 前缀，宽匹配会把所有失败都误判成权限问题并触发无意义降级。
  return (
    t.includes("eacces") ||
    t.includes("eperm") ||
    t.includes("permission denied") ||
    t.includes("access is denied") ||
    t.includes("operation not permitted")
  );
}

/**
 * 安装可灵 CLI。
 *
 * 流程：
 *   1. 定位系统 node（>= 18）
 *   2. 定位 npm-cli.js
 *   3. `node npm-cli.js install -g <pkg>`
 *   4. 失败且疑似权限问题 → 降级 `--prefix ~/.npm-global` 重试一次
 *   5. 清缓存重新探测 CLI，确认落地
 */
export async function installKlingCli(
  region: KlingRegion,
  onProgress?: InstallProgress,
): Promise<InstallResult> {
  const pkg = klingPackageName(region);

  onProgress?.("locating_node", "正在定位 Node.js…");
  const nodePath = await locateSystemNode();
  if (!nodePath) {
    return {
      ok: false,
      packageName: pkg,
      message:
        "未找到 Node.js。可灵 CLI 需要系统 Node ≥ 18，请先安装 Node 后重试（Homebrew: brew install node）。",
    };
  }

  const version = await readNodeVersion(nodePath);
  const major = parseInt((version || "").replace(/^v/, ""), 10);
  if (Number.isFinite(major) && major > 0 && major < 18) {
    return {
      ok: false,
      packageName: pkg,
      message: `系统 Node 版本过低（${version || "未知"}），可灵 CLI 需要 ≥ 18。`,
    };
  }

  onProgress?.("locating_npm", "正在定位 npm…");
  const npmCli = await locateNpmCli(nodePath);
  if (!npmCli) {
    return {
      ok: false,
      packageName: pkg,
      message:
        "未找到 npm（npm-cli.js）。请确认 Node.js 安装完整（应包含 lib/node_modules/npm）。",
    };
  }

  const baseArgs = [npmCli, "install", "-g", pkg];

  onProgress?.("installing", `正在安装 ${pkg}…`);
  let r = await runProcess(nodePath, baseArgs, {
    timeoutMs: 300000,
    env: process.env as unknown as Record<string, string>,
  });

  let usedPrefix = "";
  // 记住首次安装的错误输出，验证失败时透出，便于定位真实原因
  const firstError = (r.err || r.out || "").trim();

  if (!r.ok && looksLikePermissionError(r.err || r.out)) {
    // 权限问题 → 降级到用户级 prefix
    const prefix = fallbackPrefix();
    if (prefix) {
      onProgress?.("installing_fallback", `权限不足，改装到 ${prefix}…`);
      try {
        fs.mkdirSync(prefix, { recursive: true });
      } catch {
        // ignore
      }
      r = await runProcess(
        nodePath,
        [...baseArgs, "--prefix", prefix],
        {
          timeoutMs: 300000,
          env: process.env as unknown as Record<string, string>,
        },
      );
      if (r.ok) usedPrefix = prefix;
    }
  }

  if (!r.ok) {
    const detail = (r.err || r.out || "").trim().slice(0, 800);
    return {
      ok: false,
      packageName: pkg,
      message: `安装 ${pkg} 失败。${detail || `退出码 ${r.exitCode}`}`,
    };
  }

  onProgress?.("verifying", "安装完成，正在验证…");
  resetCliCache();
  const entry = await getCliEntry();
  if (!entry) {
    return {
      ok: false,
      packageName: pkg,
      prefix: usedPrefix || undefined,
      message: `安装命令执行成功，但仍未探测到 ${pkg}。请检查 npm 全局目录是否在 PATH 或插件的探测范围内。${
        firstError ? `（首次安装输出：${firstError.slice(0, 300)}）` : ""
      }`,
    };
  }

  return {
    ok: true,
    packageName: pkg,
    prefix: usedPrefix || undefined,
    version: entry.version,
  };
}
