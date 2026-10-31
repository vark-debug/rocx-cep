/**
 * Node 层路径工具（扩展目录 / 插件私有数据目录）
 *
 * CEP 没有 UXP 的 `plugin-data:` 协议，取而代之的是扩展安装目录本身：
 *   Win：%APPDATA%\Adobe\CEP\extensions\<id>
 *   mac：~/Library/Application Support/Adobe/CEP/extensions\<id>
 * 该目录对当前用户可写（CEP 扩展默认装在用户目录下），
 * 所以「工程未保存时的降级存储」就落在扩展目录下的 .rocx-cep-data/。
 */
import { fs, path } from "../../lib/cep/node";
import { csi } from "../../lib/utils/bolt";

/** 插件私有数据目录名 */
const DATA_DIR_NAME = ".rocx-cep-data";

/** 扩展根目录（CEP 安装目录） */
export function getExtensionRoot(): string {
  try {
    const root = csi.getSystemPath("extension");
    if (root) return String(root);
  } catch (e) {
    console.warn("[storage] 取扩展目录失败:", e);
  }
  return "";
}

/** 插件私有数据目录（不存在则创建） */
export function getPluginDataDir(): string {
  const root = getExtensionRoot();
  if (!root) return "";
  const dir = path.join(root, DATA_DIR_NAME);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    console.warn("[storage] 创建插件数据目录失败:", e);
  }
  return dir;
}

/**
 * 简易字符串 hash（FNV-1a），用于降级路径的文件名。
 *
 * 与 RocX 侧保持一致：同一个工程路径永远映射到同一个文件名，
 * 面板重开 / 插件重启后仍能找回记录。
 */
export function hashPath(p: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 文件名里的非法字符 → 下划线 */
export function sanitizeFileName(name: string): string {
  return (name || "records").replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 把工程路径拆成「所在目录 + 文件名基址（去扩展名）」。
 *
 * 例：/x/B.prproj → { dir: "/x", base: "B" }
 */
export function splitProjectPath(p: string): { dir: string; base: string } {
  const norm = (p || "").replace(/[\\/]+$/, "");
  const lastSeg = norm.split(/[\\/]/).pop() || "";
  const dot = lastSeg.lastIndexOf(".");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return {
    dir: idx >= 0 ? norm.slice(0, idx) : norm,
    base: dot > 0 ? lastSeg.slice(0, dot) : lastSeg,
  };
}
