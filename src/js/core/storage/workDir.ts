/**
 * 生成结果工作目录（Node 层）
 *
 * 主路径：工程文件旁的 `AI-Generated-Media/`
 *   → 与 RocX（UXP 版）行为一致：生成结果跟着工程走，换机/换工程不丢。
 * 降级：插件私有数据目录下的 `AI-Generated-Media/`
 *   → 工程未保存（path 为空）或工程目录不可写时使用。
 *
 * 目录形态：
 *   <workDir>/References/   抓帧得到的参考图
 *   <workDir>/Imports/      下载下来的生成结果（导入工程用）
 */
import { fs, path } from "../../lib/cep/node";
import { getPluginDataDir, splitProjectPath } from "./paths";

/** 工作目录名 */
export const WORK_DIR_NAME = "AI-Generated-Media";

/** 参考素材子目录 */
export const REFERENCES_SUBDIR = "References";

/** 生成结果子目录 */
export const IMPORTS_SUBDIR = "Imports";

export interface WorkDirResult {
  ok: boolean;
  /** 目录绝对路径 */
  dir?: string;
  /** 是否走了降级路径 */
  fallback?: boolean;
  error?: string;
}

/** 确保目录存在（逐级创建） */
function ensureDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fs.existsSync(dir);
  } catch (e) {
    console.warn("[storage] 创建目录失败:", dir, e);
    return false;
  }
}

/**
 * 取工作目录。
 *
 * @param projectPath 工程文件绝对路径（未保存时传空串）
 * @param sub 子目录名（不传则只返回根目录）
 */
export function ensureWorkDir(
  projectPath?: string,
  sub?: string,
): WorkDirResult {
  const segs = sub ? [WORK_DIR_NAME, sub] : [WORK_DIR_NAME];

  if (projectPath) {
    const { dir } = splitProjectPath(projectPath);
    if (dir) {
      let cur = dir;
      let ok = true;
      for (const seg of segs) {
        cur = path.join(cur, seg);
        if (!ensureDir(cur)) {
          ok = false;
          break;
        }
      }
      if (ok) return { ok: true, dir: cur, fallback: false };
      console.warn("[storage] 工程旁工作目录创建失败，降级到插件数据目录");
    }
  }

  const dataDir = getPluginDataDir();
  if (!dataDir) {
    return { ok: false, error: "无法定位插件数据目录" };
  }
  let cur = dataDir;
  let ok = true;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    if (!ensureDir(cur)) {
      ok = false;
      break;
    }
  }
  if (!ok) {
    return { ok: false, error: "无法创建插件数据目录下的工作目录" };
  }
  return { ok: true, dir: cur, fallback: true };
}

/**
 * 在工作目录里分配一个不冲突的文件名。
 *
 * 例：目标 `clip.mp4` 已存在 → `clip_1.mp4` → `clip_2.mp4` …
 */
export function uniqueFilePath(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let candidate = path.join(dir, fileName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${counter}${ext}`);
    counter++;
    if (counter > 999) break;
  }
  return candidate;
}
