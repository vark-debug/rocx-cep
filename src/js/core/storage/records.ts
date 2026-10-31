/**
 * 生成记录读写（Node 层）
 *
 * 主路径：`<工程文件所在目录>/<工程名>.ai-gen.json`
 * 降级：`<插件数据目录>/ai-gen-records/<hash>.json`
 *
 * 与 RocX（UXP 版）一致的要点：
 *   - 写入路由来自记录自身的归属工程（data.projectPath），不是「调用瞬间的活动工程」，
 *     避免多工程并行时把 A 工程的记录写进 B 工程的文件。
 *   - 写盘前剥离 base64 缩略图（会让 JSON 膨胀到几 MB，导致写盘失败后被迫降级）。
 *   - 探针实时判定 primary 路径是否可写（读盘里的 storageMode 可能是历史残留）。
 */
import { fs, path } from "../../lib/cep/node";
import type { GenerationRecord, ProjectRecords } from "../../../shared/types";
import { getPluginDataDir, hashPath, sanitizeFileName, splitProjectPath } from "./paths";

/** 记录文件名后缀 */
const FILENAME_SUFFIX = ".ai-gen.json";

/** 降级目录名 */
const FALLBACK_DIR = "ai-gen-records";

/** 记录归属信息 */
export interface RecordsTarget {
  /** 工程文件绝对路径（路由依据） */
  projectPath?: string;
}

/** 主路径下的记录文件绝对路径 */
function primaryPath(projectPath: string): string {
  const { dir, base } = splitProjectPath(projectPath);
  const name = sanitizeFileName(base || "records");
  return path.join(dir || path.sep, name + FILENAME_SUFFIX);
}

/** 降级路径下的记录文件绝对路径 */
function fallbackPath(projectPath: string): string {
  const dataDir = getPluginDataDir();
  return path.join(dataDir, FALLBACK_DIR, `${hashPath(projectPath)}.json`);
}

function readJson(file: string): ProjectRecords | null {
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, "utf-8");
    if (!txt) return null;
    return JSON.parse(txt) as ProjectRecords;
  } catch (e) {
    console.warn("[records] 读取失败:", file, e);
    return null;
  }
}

function writeJson(file: string, data: ProjectRecords): boolean {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.warn("[records] 写入失败:", file, e);
    return false;
  }
}

/** 剥离 base64 缩略图（落盘体积控制） */
function sanitizeRecords(records: GenerationRecord[]): GenerationRecord[] {
  return records.map((r) => {
    const { thumbDataUrl, ...rest } = r;
    const references = (r.references || []).map((ref) => {
      const { thumbDataUrl: _omit, ...refRest } = ref;
      return refRest;
    });
    return { ...rest, references } as GenerationRecord;
  });
}

/**
 * 实时探针：在 primary 路径下写一个临时小文件再删掉，
 * 确认当前 primary 路径**实际可写**。
 *
 * 比读盘 JSON 里的 storageMode 更准确 —— 那个字段可能是历史残留
 * （比如工程目录后来变成只读）。
 */
export function probePrimary(projectPath: string): {
  primaryAvailable: boolean;
  error?: string;
} {
  if (!projectPath) return { primaryAvailable: false, error: "工程未保存" };
  const { dir } = splitProjectPath(projectPath);
  const probeFile = path.join(dir || path.sep, ".ai-gen-probe.json");
  try {
    fs.writeFileSync(probeFile, "{}", "utf-8");
    fs.unlinkSync(probeFile);
    return { primaryAvailable: true };
  } catch (e: any) {
    return {
      primaryAvailable: false,
      error: String(e?.message || e),
    };
  }
}

/**
 * 读取某个工程的生成记录。
 *
 * 两处都读不到时返回空记录集（而不是报错）—— 当前工程可能只是还没生成过。
 */
export function readRecords(target: RecordsTarget): {
  ok: boolean;
  data: ProjectRecords | null;
  error?: string;
} {
  const projectPath = target.projectPath || "";
  if (!projectPath) {
    return { ok: false, data: null, error: "工程未保存，无法定位记录文件" };
  }

  const primary = primaryPath(projectPath);
  const fromPrimary = readJson(primary);
  if (fromPrimary) {
    fromPrimary.storageMode = "primary";
    return { ok: true, data: fromPrimary };
  }

  const fallback = readJson(fallbackPath(projectPath));
  if (fallback) {
    fallback.storageMode = "fallback";
    return { ok: true, data: fallback };
  }

  return {
    ok: true,
    data: {
      projectPath,
      records: [],
      storageMode: "primary",
    },
  };
}

/**
 * 写回生成记录。
 *
 * @param data 记录集（自带归属信息）
 * @param liveProjectPath 当前活动工程路径（仅在记录缺少归属时用作兜底）
 */
export function writeRecords(
  data: ProjectRecords,
  liveProjectPath?: string,
): { ok: boolean; error?: string; storageMode: "primary" | "fallback" } {
  const targetPath = data.projectPath || liveProjectPath || "";

  if (!targetPath) {
    return { ok: false, error: "工程未保存，无法写入记录", storageMode: "primary" };
  }

  const payload: ProjectRecords = {
    ...data,
    records: sanitizeRecords(data.records || []),
  };

  if (writeJson(primaryPath(targetPath), payload)) {
    return { ok: true, storageMode: "primary" };
  }
  if (writeJson(fallbackPath(targetPath), payload)) {
    return { ok: true, storageMode: "fallback" };
  }
  return { ok: false, error: "写入记录失败", storageMode: "fallback" };
}
