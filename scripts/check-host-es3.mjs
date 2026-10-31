/**
 * Host 层 ES3 合规检查
 *
 * ExtendScript 跑的是 ECMAScript 3：
 *   - 没有 let/const、箭头函数、Promise、模板字符串 → 这些由 babel 降级，没问题
 *   - **没有 ES5+ 的内建方法**（forEach/map/trim/Object.keys/Array.isArray/Date.now…）
 *     → babel 只转语法、不转内建方法，编译能过，运行时才炸
 *
 * 所以在构建前静态扫一遍 src/jsx，把这类调用拦下来。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath 而非 .pathname：Windows 下 .pathname 产生 "/C:/..."，
// 拼接后会得到 "C:\C:\..." 双盘符路径
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src", "jsx");

/** 禁用的内建方法（ES5+） */
const BANNED = [
  // 数组（ES5）
  /\.forEach\s*\(/,
  /\.map\s*\(/,
  /\.filter\s*\(/,
  /\.reduce\s*\(/,
  /\.some\s*\(/,
  /\.every\s*\(/,
  /\.find\s*\(/,
  /\.findIndex\s*\(/,
  /\.fill\s*\(/,
  /\.flat\s*\(/,
  /\.flatMap\s*\(/,
  /\.includes\s*\(/,
  /\.entries\s*\(/,
  /\.values\s*\(/,
  // 字符串（ES5/ES6）
  /\.trim\s*\(/,
  /\.trimStart\s*\(/,
  /\.trimEnd\s*\(/,
  /\.padStart\s*\(/,
  /\.padEnd\s*\(/,
  /\.repeat\s*\(/,
  /\.startsWith\s*\(/,
  /\.endsWith\s*\(/,
  // 对象 / 静态方法
  /\bObject\.keys\s*\(/,
  /\bObject\.assign\s*\(/,
  /\bObject\.entries\s*\(/,
  /\bObject\.values\s*\(/,
  /\bObject\.getOwnPropertyNames\s*\(/,
  /\bArray\.isArray\s*\(/,
  /\bArray\.from\s*\(/,
  /\bNumber\.isFinite\s*\(/,
  /\bNumber\.isNaN\s*\(/,
  /\bNumber\.isInteger\s*\(/,
  /\bMath\.trunc\s*\(/,
  /\bString\.raw\s*\(/,
  // Date（ES5）
  /\bDate\.now\s*\(/,
];

/** 收集目录下的 .ts 文件 */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".ts") || p.endsWith(".js")) out.push(p);
  }
  return out;
}

/** 去掉注释（块注释 + 行注释），避免注释里的文字被误判 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

const problems = [];

for (const file of collect(SRC)) {
  const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
  lines.forEach((line, i) => {
    for (const re of BANNED) {
      if (re.test(line)) {
        problems.push({
          file: relative(ROOT, file),
          line: i + 1,
          text: line.trim(),
          re: String(re),
        });
      }
    }
  });
}

if (problems.length) {
  console.error("\n✖ host 层违反 ES3 限制（ExtendScript 没有这些内建方法）：\n");
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ${p.re}`);
    console.error(`    ${p.text}`);
  }
  console.error(
    "\n提示：ExtendScript 只支持 ES3 内建方法。\n" +
      "      String.prototype.trim → 用 replace(/^\\s+|\\s+$/g, \"\")\n" +
      "      Date.now() → new Date().getTime()\n" +
      "      Object.keys() → 手工 for-in\n",
  );
  process.exit(1);
}

console.log("✓ host 层 ES3 合规检查通过");
