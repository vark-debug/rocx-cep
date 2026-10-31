/**
 * 生成任务编排 + 记录管理（Node 层）
 *
 * 闭环：提交 → 轮询 → 下载结果 → 导入工程 → 落盘记录。
 * 面板只负责渲染与触发动作，不参与任何文件 / 进程操作。
 *
 * 轮询节奏：起始 5s，指数退避 5 → 10 → 20 → 40 → 60s（封顶）；
 * 连续失败 6 次判定任务失联并终止。
 */
import { submitVideo, submitImage, queryTask, queryImageTask } from "./kling/provider";
import type { KlingProviderError } from "./kling/provider";
import { getSequenceInfo, importFiles } from "./ppro";
import { downloadToFile, guessFileName } from "./storage/download";
import { probePrimary, readRecords, writeRecords } from "./storage/records";
import { ensureWorkDir, uniqueFilePath, IMPORTS_SUBDIR } from "./storage/workDir";
import type {
  GenerationRecord,
  GenerationRecordStatus,
  GenerationReference,
  ImportedItem,
  KlingImageRequest,
  KlingQueryResult,
  KlingVideoRequest,
  SequenceInfo,
} from "../../shared/types";

/** 轮询起始间隔（毫秒） */
const POLL_START_MS = 5000;
/** 轮询间隔上限（毫秒） */
const POLL_MAX_MS = 60000;
/** 连续失败多少次后终止 */
const MAX_POLL_FAILURES = 6;

/** 当前工程的记录状态 */
interface GenerationState {
  projectPath: string;
  projectName?: string;
  hasSequence: boolean;
  sequenceName?: string;
  records: GenerationRecord[];
  /** 记录实际落盘位置（primary = 工程旁，fallback = 插件数据目录） */
  storageMode: "primary" | "fallback";
  /** 工程信息快照（引用稳定，供 useSyncExternalStore 使用） */
  projectInfo: ProjectInfo;
}

/** 面板可见的工程信息 */
export interface ProjectInfo {
  projectPath: string;
  projectName?: string;
  hasSequence: boolean;
  sequenceName?: string;
  /** 记录落盘位置 */
  storageMode: "primary" | "fallback";
}

let state: GenerationState = {
  projectPath: "",
  hasSequence: false,
  records: [],
  storageMode: "primary",
  projectInfo: { projectPath: "", hasSequence: false, storageMode: "primary" },
};

/**
 * 序列信息快照（引用稳定）。
 *
 * 面板用它显示「当前播放头位置 / 对应帧号」，
 * 便于核对抓帧是否命中了预期的帧。
 */
let sequenceInfoSnapshot: SequenceInfo = {
  ok: false,
  hasSequence: false,
};

/** 状态订阅者（面板用 useSyncExternalStore 订阅） */
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      console.warn("[generation] 订阅回调异常:", e);
    }
  }
}

/** 订阅记录变化 */
export function subscribeGeneration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前记录快照（引用在变化时才更新） */
export function getRecords(): GenerationRecord[] {
  return state.records;
}

/** 当前工程信息快照（引用在变化时才更新） */
export function getProjectInfo(): ProjectInfo {
  return state.projectInfo;
}

/** 当前序列信息快照（引用在变化时才更新） */
export function getSequenceInfoSnapshot(): SequenceInfo {
  return sequenceInfoSnapshot;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 随机 id（记录用） */
function newRecordId(): string {
  let s = "";
  for (let i = 0; i < 12; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return `${Date.now().toString(36)}-${s}`;
}

/** 记录集合的轻量签名（用于判断是否真的变了） */
function recordsSignature(records: GenerationRecord[]): string {
  return records.map((r) => `${r.id}:${r.updatedAt}:${r.status}`).join("|");
}

/** 记录按创建时间倒序（新的在前） */
function sortRecords(records: GenerationRecord[]): GenerationRecord[] {
  return [...records].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * primary 路径可写性探针缓存。
 *
 * 探针要真写一个临时文件，5s 一次的工程轮询里每次都跑太浪费。
 * 按工程路径缓存结果；写盘失败时会主动作废缓存（见 persist）。
 */
const primaryProbeCache = new Map<string, boolean>();

/** 探针（带缓存） */
function cachedPrimaryAvailable(projectPath: string): boolean {
  const cached = primaryProbeCache.get(projectPath);
  if (cached !== undefined) return cached;
  const r = probePrimary(projectPath);
  primaryProbeCache.set(projectPath, r.primaryAvailable);
  return r.primaryAvailable;
}

/** 序列信息的轻量签名（播放头位置变化也算变化） */
function sequenceInfoSignature(info: SequenceInfo): string {
  return [
    info.hasSequence,
    info.sequenceName,
    info.fps,
    info.playerPositionSeconds,
    info.width,
    info.height,
  ].join("|");
}

/**
 * 同步当前活动工程，并从磁盘载入它的生成记录。
 *
 * 面板挂载 / 工程切换 / 定时轮询时调用。
 *
 * ⚠ 只有状态真的变了才替换快照引用 —— React 的 useSyncExternalStore
 *   要求 getSnapshot 在没有变化时返回**同一个引用**，否则会陷入无限重渲染。
 */
export async function syncProject(): Promise<SequenceInfo> {
  let info: SequenceInfo;
  try {
    info = await getSequenceInfo();
  } catch (e: any) {
    console.warn("[generation] 读取序列信息失败:", e);
    return { ok: false, error: String(e?.message || e), hasSequence: false };
  }

  const projectPath = info.projectPath || "";
  const projectChanged = projectPath !== state.projectPath;
  const sequenceChanged =
    state.hasSequence !== !!info.hasSequence ||
    state.sequenceName !== info.sequenceName ||
    state.projectName !== info.projectName;

  if (projectChanged || sequenceChanged) {
    state.projectPath = projectPath;
    state.projectName = info.projectName;
    state.hasSequence = !!info.hasSequence;
    state.sequenceName = info.sequenceName;
  }

  // 序列信息快照：内容变了才换引用（保持 getSnapshot 稳定）
  if (sequenceInfoSignature(info) !== sequenceInfoSignature(sequenceInfoSnapshot)) {
    sequenceInfoSnapshot = info;
    emit();
  }

  if (!state.projectPath) {
    if (state.records.length) {
      state.records = [];
      state.storageMode = "primary";
      emit();
    }
    return info;
  }

  const r = readRecords({ projectPath: state.projectPath });
  const next = sortRecords(r.data?.records ?? []);
  // 落盘位置以**实时探针**为准：读盘里的 storageMode 可能是历史残留
  // （比如工程目录后来变成只读，降级写到了插件数据目录）。
  // 探针要写文件，5s 一次的轮询里每次都跑太浪费 —— 按工程路径缓存。
  const storageMode = cachedPrimaryAvailable(state.projectPath)
    ? "primary"
    : "fallback";

  const storageChanged = storageMode !== state.storageMode;
  if (storageChanged) {
    state.storageMode = storageMode;
  }

  if (
    projectChanged ||
    sequenceChanged ||
    storageChanged ||
    recordsSignature(next) !== recordsSignature(state.records)
  ) {
    state.records = next;
    state.projectInfo = {
      projectPath: state.projectPath,
      projectName: state.projectName,
      hasSequence: state.hasSequence,
      sequenceName: state.sequenceName,
      storageMode: state.storageMode,
    };
    emit();
  }

  // 面板重开/重载后，把「生成中」的记录重新接回轮询
  resumeInterruptedPolls(next);
  return info;
}

/** 正在轮询的记录 id（避免重复起轮询） */
const pollingIds = new Set<string>();

/**
 * 恢复被中断的轮询。
 *
 * 面板刷新 / 重开后，模块级的轮询循环随 JS 上下文一起没了，
 * 记录会永远停在「生成中」—— 磁盘上的 taskId 还在，
 * 重新接上轮询就能拿回结果。
 */
function resumeInterruptedPolls(records: GenerationRecord[]): void {
  for (const rec of records) {
    if (rec.status !== "pending" && rec.status !== "generating") continue;
    if (!rec.taskId) continue;
    if (pollingIds.has(rec.id)) continue;
    trackPoll(
      rec.id,
      rec.taskId,
      rec.traceId || "",
      rec.kind === "image" ? "image" : "video",
    );
  }
}

/** 启动一条记录的轮询，并登记到 pollingIds（防止重复轮询） */
function trackPoll(
  recordId: string,
  taskId: string,
  traceId: string,
  kind: "video" | "image",
): void {
  pollingIds.add(recordId);
  void pollTask(recordId, taskId, traceId, kind).finally(() => {
    pollingIds.delete(recordId);
  });
}

/** 把当前记录写回磁盘 */
function persist(): void {
  if (!state.projectPath) return;
  const r = writeRecords(
    {
      projectPath: state.projectPath,
      records: state.records,
    },
    state.projectPath,
  );
  if (r.storageMode !== state.storageMode) {
    state.storageMode = r.storageMode;
    state.projectInfo = { ...state.projectInfo, storageMode: r.storageMode };
    // 位置变了 → 探针缓存作废（下次轮询重新判定）
    primaryProbeCache.delete(state.projectPath);
  }
}

/** 找到一条记录 */
function findRecord(id: string): GenerationRecord | undefined {
  return state.records.find((r) => r.id === id);
}

/** 更新一条记录并落盘（不可变更新：换新数组，方便 React 订阅） */
function updateRecord(id: string, patch: Partial<GenerationRecord>): void {
  if (!findRecord(id)) return;
  state.records = state.records.map((r) =>
    r.id === id ? { ...r, ...patch, updatedAt: nowIso() } : r,
  );
  persist();
  emit();
}

// ---------- 提交 ----------

/**
 * 提交一次视频生成。
 *
 * 返回记录对象；生成过程在后台轮询，完成后自动下载并导入工程。
 */
export async function submitGeneration(
  req: KlingVideoRequest,
  options?: { references?: GenerationReference[] },
): Promise<GenerationRecord> {
  const references = options?.references ?? [];
  const tool = req.references?.some((r) => r.type === "reference_video")
    ? "omni_ref_video"
    : references.length
      ? "image_to_video"
      : "text_to_video";

  const record: GenerationRecord = {
    id: newRecordId(),
    kind: "video",
    prompt: req.prompt,
    params: {
      provider: "kling",
      model: req.model,
      ratio: req.ratio,
      duration: req.duration,
      resolution: req.resolution,
      tool,
    },
    references,
    status: "pending",
    pendingStage: "preparing",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    projectPath: state.projectPath,
  };

  state.records = [record, ...state.records];
  persist();
  emit();

  try {
    // 素材预上传 + 提交
    updateRecord(record.id, { pendingStage: "submitting" });
    const submitted = await submitVideo(req);
    updateRecord(record.id, {
      taskId: submitted.taskId,
      traceId: submitted.traceId,
      creditsConsumed: submitted.creditsConsumed,
      status: "generating",
      pendingStage: undefined,
      submittedAt: nowIso(),
    });
    trackPoll(record.id, submitted.taskId, submitted.traceId, "video");
  } catch (e) {
    const err = e as KlingProviderError;
    updateRecord(record.id, {
      status: "failed",
      pendingStage: undefined,
      error: {
        message: err?.message || String(e),
        errorType: err?.kind,
      },
    });
  }
  return record;
}

/**
 * 提交一次图片生成。
 *
 * 与视频提交的差别只有三处：
 *   - 记录 kind = "image"（列表据此渲染图片预览而非视频播放器）
 *   - params.duration = 0（图片没有时长）、params.resolution 是 "1k"/"2k"/"4k"
 *   - 轮询用 queryImageTask（结果地址取无水印版）
 */
export async function submitImageGeneration(
  req: KlingImageRequest,
  options?: { references?: GenerationReference[] },
): Promise<GenerationRecord> {
  const references = options?.references ?? [];
  // 图片模式只吃图片参考（视频参考会被可灵拒收）
  const imageRefs = references.filter((r) => r.type === "reference_image");
  const tool = imageRefs.length ? "image_to_image" : "text_to_image";

  const record: GenerationRecord = {
    id: newRecordId(),
    kind: "image",
    prompt: req.prompt,
    params: {
      provider: "kling",
      model: req.model,
      ratio: req.ratio,
      duration: 0,
      resolution: req.resolution,
      tool,
      count: req.count,
    },
    references: imageRefs,
    status: "pending",
    pendingStage: "preparing",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    projectPath: state.projectPath,
  };

  state.records = [record, ...state.records];
  persist();
  emit();

  try {
    updateRecord(record.id, { pendingStage: "submitting" });
    const submitted = await submitImage(req);
    updateRecord(record.id, {
      taskId: submitted.taskId,
      traceId: submitted.traceId,
      creditsConsumed: submitted.creditsConsumed,
      status: "generating",
      pendingStage: undefined,
      submittedAt: nowIso(),
    });
    trackPoll(record.id, submitted.taskId, submitted.traceId, "image");
  } catch (e) {
    const err = e as KlingProviderError;
    updateRecord(record.id, {
      status: "failed",
      pendingStage: undefined,
      error: {
        message: err?.message || String(e),
        errorType: err?.kind,
      },
    });
  }
  return record;
}

// ---------- 轮询 ----------

/** 后台轮询一个任务，直到终态 */
async function pollTask(
  recordId: string,
  taskId: string,
  traceId: string,
  kind: "video" | "image",
): Promise<void> {
  let interval = POLL_START_MS;
  let failures = 0;

  for (;;) {
    await delay(interval);

    try {
      const res: KlingQueryResult =
        kind === "image"
          ? await queryImageTask(taskId, traceId)
          : await queryTask(taskId, traceId);
      failures = 0;
      updateRecord(recordId, {
        // 还在排队 → pending；已经在跑 → generating
        status: res.status === "queued" ? "pending" : "generating",
        pendingStage: res.status === "queued" ? "submitting" : undefined,
        lastPolledAt: nowIso(),
      });

      if (res.status === "succeeded") {
        const urls = res.urls?.length ? res.urls : res.url ? [res.url] : [];
        if (urls.length) {
          updateRecord(recordId, { resultUrl: urls[0] });
          await finalizeSuccess(recordId, urls, kind);
        } else {
          updateRecord(recordId, {
            status: "failed",
            error: { message: "可灵任务成功但未返回结果地址" },
          });
        }
        return;
      }

      if (res.status === "failed") {
        updateRecord(recordId, {
          status: "failed",
          error: { message: res.error || "可灵任务失败" },
        });
        return;
      }
    } catch (e) {
      failures++;
      const err = e as KlingProviderError;
      if (failures >= MAX_POLL_FAILURES) {
        updateRecord(recordId, {
          status: "failed",
          error: {
            message: `连续 ${failures} 次查询失败，已停止轮询：${
              err?.message || String(e)
            }`,
            errorType: err?.kind,
          },
        });
        return;
      }
    }

    interval = Math.min(interval * 2, POLL_MAX_MS);
  }
}

/** 延迟（毫秒） */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 收尾：下载 + 导入 ----------

/**
 * 任务成功后：下载结果 → 落工作目录 → 导入 Premiere。
 *
 * urls 可能有多个（图片按 imageCount 生成多张）—— 全部下载、全部导入，
 * 只取第一张会让用户付了 N 张的钱却只拿到 1 个文件。
 *
 * 下载全失败 → 记录置 failed（否则 UI 会永远停在「生成中」）；
 * 导入失败 → 保持 generated（结果文件在本地，用户可以手动重试导入）。
 */
async function finalizeSuccess(
  recordId: string,
  urls: string[],
  kind: "video" | "image",
): Promise<void> {
  const work = ensureWorkDir(state.projectPath, IMPORTS_SUBDIR);
  if (!work.ok || !work.dir) {
    updateRecord(recordId, {
      status: "failed",
      error: { message: work.error || "无法创建生成结果目录" },
    });
    return;
  }

  const files: string[] = [];
  let lastError = "";
  for (const url of urls) {
    const name = guessFileName(url, kind === "image" ? "image/png" : undefined);
    const dest = uniqueFilePath(work.dir, name);
    const dl = await downloadToFile(url, dest);
    if (!dl.ok || !dl.path) {
      lastError = dl.error || "结果下载失败";
      continue;
    }
    files.push(dl.path);
  }

  if (!files.length) {
    updateRecord(recordId, {
      status: "failed",
      error: { message: lastError || "结果下载失败" },
    });
    return;
  }

  updateRecord(recordId, {
    workFile: files[0],
    workFiles: files,
    status: "generated",
    // 部分下载失败时留个提示，但不挡住已拿到的文件
    error: lastError ? { message: `部分结果下载失败：${lastError}` } : undefined,
  });
  await importRecordToProject(recordId);
}

/**
 * 把某条记录的生成结果导入 Premiere 项目面板。
 *
 * 依赖 host 层 `importFiles` —— 它导入后按媒体路径在项目面板里定位条目，
 * 并把条目信息（名称 / nodeId）回传。
 *
 * 图片一次生成多张时（workFiles）全部导入 —— 只导第一张等于白付了另外几张的钱。
 */
export async function importRecordToProject(
  recordId: string,
): Promise<{ ok: boolean; error?: string; items?: ImportedItem[] }> {
  const rec = findRecord(recordId);
  if (!rec) return { ok: false, error: "记录不存在" };
  const files = rec.workFiles?.length ? rec.workFiles : rec.workFile ? [rec.workFile] : [];
  if (!files.length) return { ok: false, error: "记录没有本地结果文件" };

  try {
    const res = await importFiles(files);
    if (!res.ok) {
      updateRecord(recordId, {
        error: { message: res.error || "导入工程失败" },
      });
      return { ok: false, error: res.error, items: res.items };
    }
    updateRecord(recordId, {
      status: "imported",
      importedFile: rec.workFile,
      error: undefined,
    });
    return { ok: true, items: res.items };
  } catch (e: any) {
    const message = String(e?.message || e);
    updateRecord(recordId, { error: { message } });
    return { ok: false, error: message };
  }
}

/** 删除一条记录 */
export function removeRecord(recordId: string): void {
  const before = state.records.length;
  state.records = state.records.filter((r) => r.id !== recordId);
  if (state.records.length !== before) {
    persist();
    emit();
  }
}

/** 重试一个失败的任务（用同一个模型 / 提示词重新提交） */
export async function retryGeneration(
  recordId: string,
): Promise<GenerationRecord | null> {
  const rec = findRecord(recordId);
  if (!rec) return null;
  const refs = rec.references || [];

  if (rec.kind === "image") {
    return submitImageGeneration(
      {
        model: rec.params.model,
        prompt: rec.prompt,
        ratio: rec.params.ratio,
        resolution: rec.params.resolution,
        count: rec.params.count || 1,
        references: refs.map((r) => ({
          type: r.type,
          localPath: r.localPath,
        })),
      },
      { references: refs },
    );
  }

  return submitGeneration(
    {
      model: rec.params.model,
      prompt: rec.prompt,
      ratio: rec.params.ratio,
      duration: rec.params.duration,
      resolution: rec.params.resolution,
      references: refs.map((r) => ({
        type: r.type,
        localPath: r.localPath,
      })),
    },
    { references: refs },
  );
}

export type { GenerationRecord, GenerationRecordStatus };
