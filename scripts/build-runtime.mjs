/**
 * 构建内嵌 runtime：node 官方二进制 + 可灵 CLI（pkg / exe 安装器的 payload）
 *
 * 产物布局（安装器原样落位，cli.ts 的 bundled 探测按这个布局找）：
 *   <outDir>/
 *     bin/node            (win: bin/node.exe)
 *     kling/node_modules/@klingai/cli-cn/dist/cli.js
 *
 * 用法（在构建机系统 node >= 18 上运行）：
 *   node scripts/build-runtime.mjs --platform darwin-arm64 --out build/runtime/darwin-arm64
 *   node scripts/build-runtime.mjs --platform darwin-x64  --out build/runtime/darwin-x64
 *   node scripts/build-runtime.mjs --platform win-x64     --out build/runtime/win-x64
 *
 * 平台对应：
 *   darwin-arm64 → node-vX-darwin-arm64.tar.gz；darwin-x64 → node-vX-darwin-x64.tar.gz
 *   win-x64      → node-vX-win-x64.zip
 *
 * CLI 是零 npm 依赖的单文件包（dependencies 为空，bin: dist/cli.js，engines node>=18），
 * 没有平台相关的 native 模块，任何平台构建机装出的包都能跨平台使用；
 * 这里仍然按目标平台分别构建，保证布局与自检与真实安装环境一致。
 */
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";

/** CLI 锁定版本（随插件发版；面板仍保留 npm 在线安装作为更新通道） */
const KLING_CLI_VERSION = "0.2.3";

/** node LTS 大版本（CLI 只要求 >=18，选成熟 LTS） */
const NODE_MAJOR = 22;

const NODE_DIST = `https://nodejs.org/dist`;
const KLING_PACKAGE = "@klingai/cli-cn";

/** 平台 → node dist index.json 的 files 代号（darwin 在索引里叫 osx-*-tar） */
const NODE_FILE_KEYS = {
  "darwin-arm64": "osx-arm64-tar",
  "darwin-x64": "osx-x64-tar",
  "win-x64": "win-x64-zip",
};

/** 解析参数 */
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const platform = get("platform");
  const out = get("out");
  if (!platform || !out) {
    console.error("用法: node scripts/build-runtime.mjs --platform <p> --out <dir>");
    console.error("  platform: darwin-arm64 | darwin-x64 | win-x64");
    process.exit(1);
  }
  if (!["darwin-arm64", "darwin-x64", "win-x64"].includes(platform)) {
    console.error(`不支持的平台: ${platform}`);
    process.exit(1);
  }
  return { platform, out: path.resolve(out) };
}

/** 拉取 node dist 索引，取 NODE_MAJOR 最新的 LTS 版本号 */
async function resolveNodeVersion(platform) {
  const indexFile = path.join(process.env.TMPDIR || "/tmp", `node-dist-index-${Date.now()}.json`);
  try {
    await download(`${NODE_DIST}/index.json`, indexFile);
  } catch (e) {
    throw new Error(`拉取 node dist 索引失败: ${e.message}`);
  }
  const { readFileSync, rmSync } = await import("node:fs");
  const list = JSON.parse(readFileSync(indexFile, "utf8"));
  rmSync(indexFile, { force: true });
  const pick = list.find(
    (v) =>
      v.version.startsWith(`v${NODE_MAJOR}.`) &&
      v.lts &&
      v.files.includes(NODE_FILE_KEYS[platform]),
  );
  if (!pick) throw new Error(`node v${NODE_MAJOR} LTS 未找到`);
  return pick.version; // 如 "v22.20.0"
}

/** 下载文件到本地（fetch 失败时 curl 兜底 —— 构建机的代理常配在系统层，node fetch 不自动走） */
async function download(url, dest, attempt = 0) {
  try {
    console.log(`  ↓ ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(dest));
  } catch (e) {
    if (attempt < 2) {
      console.warn(`  下载失败重试 (${attempt + 1}/2): ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return download(url, dest, attempt + 1);
    }
    // 最终兜底：系统 curl（读系统/环境代理配置）
    console.warn("  fetch 不可达，改用 curl 下载");
    execFileSync("curl", ["-fL", "--retry", "3", "-o", dest, url], {
      stdio: "inherit",
    });
  }
}

/** 运行命令（同步，失败即抛） */
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

async function main() {
  const { platform, out } = parseArgs();
  const isWin = platform === "win-x64";
  const tmp = path.join(path.dirname(out), `_tmp-${platform}-${Date.now()}`);

  console.log(`[runtime] 平台=${platform} 输出=${out}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

  // ---- 1) node 官方二进制 ----
  const nodeVersion = await resolveNodeVersion(platform);
  const nodeBase = `node-${nodeVersion}-${platform}`;
  const archive = path.join(tmp, isWin ? `${nodeBase}.zip` : `${nodeBase}.tar.gz`);
  console.log(`[runtime] node ${nodeVersion} (${platform})`);
  await download(
    isWin
      ? `${NODE_DIST}/${nodeVersion}/${nodeBase}.zip`
      : `${NODE_DIST}/${nodeVersion}/${nodeBase}.tar.gz`,
    archive,
  );

  const binDir = path.join(out, "bin");
  mkdirSync(binDir, { recursive: true });
  const nodeExe = path.join(binDir, isWin ? "node.exe" : "node");
  if (isWin) {
    // unzip 到 tmp，再拷 node.exe（系统 unzip 处理 zip）
    run("unzip", ["-q", archive, "-d", tmp]);
    const from = path.join(tmp, nodeBase, "node.exe");
    if (!existsSync(from)) throw new Error(`解压后未找到 node.exe: ${from}`);
    execFileSync("cp", [from, nodeExe]);
  } else {
    // tar 解压后直接拿 bin/node（保留可执行位）
    run("tar", ["-xzf", archive, "-C", tmp]);
    const from = path.join(tmp, nodeBase, "bin", "node");
    if (!existsSync(from)) throw new Error(`解压后未找到 node: ${from}`);
    execFileSync("cp", [from, nodeExe]);
    execFileSync("chmod", ["+x", nodeExe]);
  }
  if (!statSync(nodeExe).isFile()) throw new Error("node 二进制拷贝失败");

  // ---- 2) 可灵 CLI（零依赖 npm 包，装到隔离 prefix）----
  console.log(`[runtime] ${KLING_PACKAGE}@${KLING_CLI_VERSION}`);
  const klingDir = path.join(out, "kling");
  mkdirSync(klingDir, { recursive: true });
  run("npm", [
    "i",
    "--prefix", klingDir,
    `${KLING_PACKAGE}@${KLING_CLI_VERSION}`,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  const cliJs = path.join(
    klingDir, "node_modules", "@klingai", "cli-cn", "dist", "cli.js",
  );
  if (!existsSync(cliJs)) throw new Error(`CLI 入口未找到: ${cliJs}`);

  // ---- 3) 自检：node 可跑 + CLI 可跑 ----
  console.log("[runtime] 自检");
  const v = execFileSync(nodeExe, ["--version"], { encoding: "utf8" }).trim();
  console.log(`  node ${v}`);
  if (!v.startsWith(`v${NODE_MAJOR}.`)) throw new Error(`node 版本异常: ${v}`);
  const cv = execFileSync(nodeExe, [cliJs, "--version"], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
  console.log(`  kling CLI ${cv}`);
  if (!cv) throw new Error("CLI --version 无输出");

  const sizeMb = (
    [binDir, klingDir].reduce(
      (n, dir) => n + execFileSync("du", ["-sk", dir], { encoding: "utf8" }).split("\t")[0] * 1,
      0,
    ) / 1024
  ).toFixed(1);
  console.log(`[runtime] 完成（${sizeMb} MB）→ ${out}`);
}

main().catch((e) => {
  console.error(`[runtime] 构建失败: ${e?.message || e}`);
  process.exit(1);
});
