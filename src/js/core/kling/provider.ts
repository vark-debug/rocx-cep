/**
 * 可灵 provider（Node 层编排）
 *
 * 与 RocX（UXP 版）的差异：
 *   - UXP 侧 provider 依赖 Vue `ref` + Comlink 桥；CEP 侧没有跨进程桥 ——
 *     panel 与 Node 层同进程（`--mixed-context`），本模块直接被 panel import，
 *     所以这里用「模块级状态 + 订阅回调」代替 `ref`。
 *   - UXP 侧环境快照经 C++ addon 落盘；CEP 侧直接用 Node `fs` 写扩展目录。
 *
 * provider 的三条职责：
 *   1. 能力发现（who_am_i → 模型清单 / 默认模型）
 *   2. 账户信息（account → 灵感值 / 会员）
 *   3. 生成编排（提交 / 轮询 / 素材预上传衔接）
 */
import { execKlingCli, spawnKlingCli } from "./cli";
import {
  KLING_PROVIDER_ID,
  KLING_TOOL_IMAGE_TO_IMAGE,
  KLING_TOOL_IMAGE_TO_VIDEO,
  KLING_TOOL_OMNI_REF_VIDEO,
  KLING_TOOL_TEXT_TO_IMAGE,
  KLING_TOOL_TEXT_TO_VIDEO,
  buildKlingGenArgs,
  buildKlingImageArgs,
  buildKlingImageModelDescriptors,
  buildKlingModelDescriptors,
  buildKlingQueryArgs,
  countKlingImageSlots,
  countKlingSlots,
  extractKlingCredits,
  extractKlingErrorMessage,
  extractKlingGenerationId,
  extractKlingImageResultUrls,
  extractKlingResultUrl,
  findKlingModelSpec,
  mapKlingStatus,
  newKlingTraceId,
  parseKlingCatalog,
  pickKlingDefaultModel,
  pickKlingImageDefaultModel,
} from "./wireFormat";
import type { KlingModelCatalog } from "./wireFormat";
import {
  extractKlingRechargeUrl,
  friendlyKlingError,
  parseKlingError,
} from "./errorMap";
import { ensureKlingUrls, isKlingUrlExpired } from "./preUpload";
import {
  clearEnvSnapshot,
  persistEnvSnapshot,
  restoreEnvSnapshot,
} from "./envSnapshot";
import type {
  KlingCliCode,
  KlingCliExecResult,
  KlingEnvState,
  KlingImageModelDescriptor,
  KlingImageRequest,
  KlingModelDescriptor,
  KlingQueryResult,
  KlingReferenceInput,
  KlingSubmitResult,
  KlingVideoRequest,
} from "../../../shared/types";

/** provider 抛出的错误（带分类，UI 可据此决定提示样式） */
export class KlingProviderError extends Error {
  /** 错误分类（来自 errorMap 的文本归类） */
  readonly kind: string;
  /** CLI 错误码（环境类错误才有） */
  readonly code?: KlingCliCode;

  constructor(message: string, kind: string, code?: KlingCliCode) {
    super(message);
    this.name = "KlingProviderError";
    this.kind = kind;
    this.code = code;
  }
}

// ---------- 模块级状态（替代 UXP 侧的 Vue ref） ----------

/** 环境自检状态 */
let envState: KlingEnvState = { ready: false };

/** 模型清单（who_am_i 拉取后填充） */
let modelDescriptors: KlingModelDescriptor[] = [];

/**
 * 图片模型清单（who_am_i 拉取后填充）。
 *
 * 与视频模型清单**分开存**：两者的参数域完全不同
 * （图片是 img_resolution + imageCount，视频是 resolution + duration），
 * 混在一份描述符里会让 UI 在切模式时出现非法的参数组合。
 */
let imageModelDescriptors: KlingImageModelDescriptor[] = [];

/** 状态变更订阅者 */
const listeners = new Set<() => void>();

/** 通知订阅者（面板侧用 useSyncExternalStore 订阅） */
function emit(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      console.warn("[kling] 状态订阅回调异常:", e);
    }
  }
}

/** 合并写入环境状态并通知 */
function patchEnv(patch: Partial<KlingEnvState>): void {
  envState = { ...envState, ...patch };
  emit();
}

/** 订阅可灵状态变化；返回取消订阅函数 */
export function subscribeKlingState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前环境状态快照 */
export function getKlingEnv(): KlingEnvState {
  return envState;
}

/** 当前模型清单快照 */
export function getKlingModels(): KlingModelDescriptor[] {
  return modelDescriptors;
}

/** 当前图片模型清单快照 */
export function getKlingImageModels(): KlingImageModelDescriptor[] {
  return imageModelDescriptors;
}

/** 面板渲染用的一次性快照（env + models） */
export function getKlingState(): { env: KlingEnvState; models: KlingModelDescriptor[] } {
  return { env: envState, models: modelDescriptors };
}

// ---------- 模型清单缓存 ----------

let catalogCache: KlingModelCatalog | null = null;
let catalogPromise: Promise<boolean> | null = null;

/** 清空模型清单缓存（设置面板「重新检测」用） */
export function resetKlingCatalogCache(): void {
  catalogCache = null;
  catalogPromise = null;
}

/** 同步取已缓存的 catalog（不发 CLI）；未拉过时返回 null */
export function getKlingCatalogSync(): KlingModelCatalog | null {
  return catalogCache;
}

/** CLI 错误码 → 环境未就绪的原因 */
function reasonOfCliCode(
  code: KlingCliCode,
): "cli_not_installed" | "not_logged_in" | "error" {
  if (code === "cli_not_installed") return "cli_not_installed";
  if (code === "not_logged_in") return "not_logged_in";
  return "error";
}

/**
 * 拉取可灵模型清单（`who_am_i --quiet`）。
 *
 * 失败时**不回退到硬编码清单** —— 服务端随时可能上下架模型，
 * 写死的清单只会让用户提交到已失效的模型。
 */
export async function loadKlingModels(opts?: {
  force?: boolean;
}): Promise<boolean> {
  if (!opts?.force && catalogCache) return true;
  if (!opts?.force && catalogPromise) {
    await catalogPromise;
    return catalogCache !== null;
  }

  const run = (async (): Promise<boolean> => {
    const res = await execKlingCli(["who_am_i", "--quiet"], { timeoutMs: 30000 });
    if (!res.ok) {
      catalogCache = null;
      modelDescriptors = [];
      imageModelDescriptors = [];
      patchEnv({
        ready: false,
        reason: reasonOfCliCode(res.code),
        message: res.error || "可灵环境自检失败",
        checkedAt: new Date().toISOString(),
      });
      console.warn("[kling] 模型清单加载失败:", res.error || res.code);
      persistEnvSnapshot(envState, null);
      return false;
    }

    const catalog = parseKlingCatalog(res.data);
    const models = buildKlingModelDescriptors(catalog);
    const imageModels = buildKlingImageModelDescriptors(catalog);
    if (models.length === 0) {
      catalogCache = null;
      modelDescriptors = [];
      imageModelDescriptors = [];
      patchEnv({
        ready: false,
        reason: "error",
        message: "可灵未返回任何可用视频模型",
        checkedAt: new Date().toISOString(),
      });
      console.warn("[kling] 模型清单为空（who_am_i 未返回可用视频模型）");
      persistEnvSnapshot(envState, null);
      return false;
    }

    catalogCache = catalog;
    modelDescriptors = models;
    imageModelDescriptors = imageModels;
    patchEnv({
      ready: true,
      reason: undefined,
      message: undefined,
      modelCount: models.length,
      checkedAt: new Date().toISOString(),
    });
    persistEnvSnapshot(envState, catalog);
    return true;
  })();

  catalogPromise = run;
  try {
    return await run;
  } finally {
    catalogPromise = null;
  }
}

/** 取模型清单；没有缓存时同步加载一次，失败抛错 */
export async function ensureKlingCatalog(): Promise<KlingModelCatalog> {
  if (catalogCache) return catalogCache;
  const ok = await loadKlingModels();
  if (!ok || !catalogCache) {
    throw new KlingProviderError(
      envState.message || "可灵模型清单不可用，请检查 CLI 安装与登录状态",
      "catalog_unavailable",
    );
  }
  return catalogCache;
}

/** 取服务端下发的默认模型 id（清单未加载时返回空串） */
export function getKlingDefaultModel(): string {
  return catalogCache ? pickKlingDefaultModel(catalogCache) : "";
}

/**
 * 取服务端下发的默认**图片**模型 id（清单未加载时返回空串）。
 *
 * 与视频侧的 getKlingDefaultModel 分开 —— 两者取的是不同工具的 defaultModel，
 * 混用会拿到视频模型 id（图片工具是 text_to_image / image_to_image）。
 */
export function getKlingImageDefaultModel(): string {
  return catalogCache ? pickKlingImageDefaultModel(catalogCache) : "";
}

// ---------- 账户信息 ----------

/** 刷新可灵账户信息（`account --quiet`）：灵感值 + 会员等级 */
export async function refreshKlingAccount(): Promise<boolean> {
  const res = await execKlingCli(["account", "--quiet"], { timeoutMs: 30000 });
  if (!res.ok) {
    patchEnv({
      message: res.error || "可灵账户信息获取失败",
      checkedAt: new Date().toISOString(),
    });
    return false;
  }
  const b = res.data as any;
  patchEnv({
    credits:
      typeof b?.availableRemainCredits === "number"
        ? b.availableRemainCredits
        : undefined,
    membershipType:
      typeof b?.membershipType === "string" ? b.membershipType : undefined,
    membershipDescription:
      typeof b?.membershipTypeDescription === "string"
        ? b.membershipTypeDescription
        : undefined,
    checkedAt: new Date().toISOString(),
  });
  persistEnvSnapshot(envState, catalogCache);
  return true;
}

/**
 * 完整环境自检（模型清单 + 账户余额）。
 *
 * 供面板启动与「重新检测」共用。
 */
export async function refreshKlingEnvInBackground(): Promise<boolean> {
  patchEnv({ checking: true });
  try {
    const ok = await loadKlingModels({ force: true });
    if (ok) await refreshKlingAccount();
    return ok;
  } finally {
    patchEnv({ checking: false });
  }
}

// ---------- 启动自检 ----------

/** 正在跑的启动自检（避免面板重复挂载时并发跑两次 CLI） */
let bootstrapPromise: Promise<void> | null = null;

/**
 * 面板启动时的环境自检。
 *
 * 流程与 RocX（UXP 版）一致：
 *   1. 先读上次快照渲染 UI（CLI 定位要 >1s，不能让面板干等）
 *   2. 再后台跑一次真实检测覆盖快照
 *
 * 失败态快照（未装 CLI / 未登录）也会被读进来，但**必须**再跑一次真实检测 ——
 * 用户很可能刚装好 CLI 或刚登录。
 */
export function bootstrapKlingEnv(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  const run = (async () => {
    // 1. 先把快照铺上去，UI 立刻有内容可显示
    const snap = restoreEnvSnapshot();
    if (snap) {
      patchEnv({
        ready: !!snap.ready,
        reason: snap.reason,
        message: snap.message,
        credits: snap.credits,
        membershipType: snap.membershipType,
        membershipDescription: snap.membershipDescription,
        modelCount: snap.modelCount,
        rechargeUrl: snap.rechargeUrl,
        checkedAt: snap.checkedAt,
      });
      if (snap.catalog) {
        const models = buildKlingModelDescriptors(snap.catalog);
        if (models.length) {
          catalogCache = snap.catalog;
          modelDescriptors = models;
          imageModelDescriptors = buildKlingImageModelDescriptors(snap.catalog);
          patchEnv({ modelCount: models.length });
        }
      }
    }

    // 2. 后台跑真实检测（catch 掉异常，避免未处理的 Promise rejection）
    try {
      await refreshKlingEnvInBackground();
    } catch (e) {
      console.warn("[kling] 启动自检失败:", e);
    }
  })();

  bootstrapPromise = run;
  // 检测结束后放开闸门：面板重新挂载（CEP 里面板可能被复用）时还能再跑
  void run.finally(() => {
    bootstrapPromise = null;
  });
  return run;
}

// ---------- 登录引导 ----------

/**
 * 启动 `kling login`（OAuth 浏览器授权）。
 *
 * 进程以后台方式启动，输出透传给调用方 —— 面板把输出显示在日志区即可。
 */
export async function startKlingLogin(
  onOutput?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  return spawnKlingCli(["login"], onOutput);
}

/** 退出登录（换账号必须先 logout） */
export async function logoutKling(): Promise<{ ok: boolean; error?: string }> {
  const res = await execKlingCli(["logout", "--quiet"], { timeoutMs: 30000 });
  if (!res.ok) {
    return { ok: false, error: res.error || "退出登录失败" };
  }
  resetKlingCatalogCache();
  patchEnv({
    ready: false,
    reason: "not_logged_in",
    credits: undefined,
    membershipType: undefined,
    membershipDescription: undefined,
    message: "已退出可灵账号",
    checkedAt: new Date().toISOString(),
  });
  // 旧快照里的余额 / 会员 / 模型清单都属旧账号，必须清掉
  clearEnvSnapshot();
  return { ok: true };
}

// ---------- trace id ----------

/**
 * CLI 的 `--task-trace-id` 是全局 flag，同一次任务的所有调用应带同一个值。
 * 提交时生成，拿到 generationId 后登记，轮询时复用。
 */
const traceIds = new Map<string, string>();

function traceIdFor(taskId: string): string {
  let id = traceIds.get(taskId);
  if (!id) {
    id = newKlingTraceId();
    traceIds.set(taskId, id);
  }
  return id;
}

// ---------- 参考素材 ----------

/**
 * 参考素材来源：优先用预上传拿到的可灵 CDN 直链（过期则回退本地路径），
 * 其次公网 URL 直传（不下载重传），否则用本地绝对路径
 * （CLI 的 resolveFileUrl 会自动上传本地文件）。
 */
function referenceSource(ref: KlingReferenceInput): string {
  if (ref.klingFileUrl && !isKlingUrlExpired(ref.klingUploadedAt)) {
    return ref.klingFileUrl;
  }
  const id = typeof ref.fileId === "string" ? ref.fileId.trim() : "";
  if (/^https?:\/\//i.test(id)) return id;
  return ref.localPath;
}

/**
 * 带参考视频时的音频参数。
 *
 * 服务端声明（omni_ref_video）写明：
 * "With this video, images+elements ≤4, and enable_audio must be false."
 * → 带视频时 enable_audio 必须为 false，否则服务端直接拒绝。
 *
 * 是否真的下发由 buildKlingGenArgs 按模型声明过滤 —— 模型没声明的参数不发，
 * 否则 CLI 会报「未知参数」。
 */
function klingVideoRefAudioArgs(): Record<string, string> {
  return { enable_audio: "false", keepOriginalSound: "true" };
}

// ---------- 生成提交 ----------

/**
 * 提交视频生成。
 *
 * 按素材类型路由到对应工具（服务端声明为准）：
 * - 有视频参考 → `omni_ref_video`（全能参考 / 视频→视频）
 * - 有图片参考 → `image_to_video`
 * - 无参考     → `text_to_video`
 */
export async function submitVideo(
  req: KlingVideoRequest,
): Promise<KlingSubmitResult> {
  const references = req.references ?? [];

  // 等抓素材时启动的预上传跑完，把 CDN 直链回填到 ref。
  // 直链就绪 → CLI 的 resolveFileUrl 直通不重传（省掉内部 4-8s 上传）；
  // 没就绪 → 保持本地路径，CLI 自行上传。
  await ensureKlingUrls(references);

  const catalog = await ensureKlingCatalog();

  const imageRefs = references.filter((r) => r.type === "reference_image");
  const videoRefs = references.filter((r) => r.type === "reference_video");
  const audioRefs = references.filter((r) => r.type === "reference_audio");

  const tool = videoRefs.length
    ? KLING_TOOL_OMNI_REF_VIDEO
    : imageRefs.length
      ? KLING_TOOL_IMAGE_TO_VIDEO
      : KLING_TOOL_TEXT_TO_VIDEO;

  const spec = findKlingModelSpec(catalog, tool, req.model);
  if (!spec) {
    const hint = videoRefs.length
      ? "（该模型不支持参考视频，换用支持全能参考的模型）"
      : imageRefs.length
        ? "（该模型不支持图生视频）"
        : "";
    throw new KlingProviderError(
      `可灵模型不可用：${req.model}${hint}`,
      "unknown_model",
    );
  }

  if (audioRefs.length) {
    throw new KlingProviderError(
      "可灵暂不支持音频参考素材（仅支持图片 / 视频参考）",
      "unsupported_reference",
    );
  }

  const images: string[] = [];
  for (const ref of imageRefs) {
    const src = referenceSource(ref);
    if (!src) {
      throw new KlingProviderError("参考素材缺少本地路径，无法提交", "invalid_reference");
    }
    images.push(src);
  }

  const videos: string[] = [];
  for (const ref of videoRefs) {
    const src = referenceSource(ref);
    if (!src) {
      throw new KlingProviderError("参考视频缺少本地路径，无法提交", "invalid_reference");
    }
    videos.push(src);
  }

  // 槽位数量预检（CLI 侧同样会校验，这里提前给出更直接的提示）
  const imageCap = countKlingSlots(spec, "image");
  const videoCap = countKlingSlots(spec, "video");
  if (images.length > imageCap) {
    throw new KlingProviderError(
      `模型 ${spec.model} 最多支持 ${imageCap} 张参考图，当前 ${images.length} 张`,
      "too_many_references",
    );
  }
  if (videos.length > videoCap) {
    throw new KlingProviderError(
      `模型 ${spec.model} 最多支持 ${videoCap} 个参考视频，当前 ${videos.length} 个`,
      "too_many_references",
    );
  }
  const cap = spec.combinedItemCap?.maxItems;
  if (typeof cap === "number" && images.length + videos.length > cap) {
    throw new KlingProviderError(
      `模型 ${spec.model} 的参考素材合计上限为 ${cap} 个，当前 ${images.length + videos.length} 个`,
      "too_many_references",
    );
  }
  const requiredInputs = (spec.inputs ?? []).filter((i) => i.required).length;
  if (images.length < requiredInputs) {
    throw new KlingProviderError(
      `模型 ${spec.model} 需要至少 ${requiredInputs} 张参考图`,
      "missing_references",
    );
  }

  const traceId = newKlingTraceId();
  const args = buildKlingGenArgs({
    tool,
    spec,
    prompt: req.prompt,
    ratio: req.ratio,
    duration: req.duration,
    resolution: req.resolution,
    images,
    videos,
    extraArgs: videos.length ? klingVideoRefAudioArgs() : undefined,
    traceId,
  });

  console.log("[kling] submitVideo", tool, JSON.stringify(args));

  const res = await execKlingCli(args, { timeoutMs: 180000 });
  if (!res.ok) throw cliFailure(res);

  const taskId = extractKlingGenerationId(res.data);
  if (!taskId) {
    throw new KlingProviderError("可灵提交响应缺少 generationId", "missing_task_id");
  }
  traceIds.set(taskId, traceId);

  return {
    taskId,
    creditsConsumed: extractKlingCredits(res.data),
    traceId,
  };
}

// ---------- 图片生成提交 ----------

/**
 * 提交图片生成。
 *
 * 按参考图有无路由：
 * - 有参考图 → `image_to_image`（图生图）
 * - 无参考图 → `text_to_image`（文生图）
 *
 * ⚠ 素材**不是** base64 data URI —— CLI 只接受 http(s) URL 或本地路径，
 *   data URI 会被当成文件路径去上传而失败。
 */
export async function submitImage(
  req: KlingImageRequest,
): Promise<KlingSubmitResult> {
  const references = req.references ?? [];

  // 等抓素材时启动的预上传跑完，把 CDN 直链回填到 ref
  await ensureKlingUrls(references);

  const catalog = await ensureKlingCatalog();

  const imageRefs = references.filter((r) => r.type === "reference_image");

  const tool = imageRefs.length
    ? KLING_TOOL_IMAGE_TO_IMAGE
    : KLING_TOOL_TEXT_TO_IMAGE;

  const spec = findKlingModelSpec(catalog, tool, req.model);
  if (!spec) {
    // 该模型可能不支持图生图（image_to_image 清单里没有它）→ 明确告知
    if (tool === KLING_TOOL_IMAGE_TO_IMAGE) {
      throw new KlingProviderError(
        `可灵模型 ${req.model} 不支持参考图，请换一个图片模型`,
        "unsupported_reference",
      );
    }
    throw new KlingProviderError(
      `可灵图片模型不可用：${req.model}`,
      "unknown_model",
    );
  }

  const images: string[] = [];
  for (const ref of imageRefs) {
    const src = referenceSource(ref);
    if (!src) {
      throw new KlingProviderError("参考图缺少本地路径，无法提交", "invalid_reference");
    }
    images.push(src);
  }

  // 槽位数量预检（CLI 侧同样会校验，这里提前给出更直接的提示）
  if (images.length) {
    const cap = countKlingImageSlots(spec);
    if (images.length > cap) {
      throw new KlingProviderError(
        `模型 ${spec.model} 最多支持 ${cap} 张参考图，当前 ${images.length} 张`,
        "too_many_references",
      );
    }
    // image_to_image 的 image_1 是必填（v3_0_omni / o1 / v3_0）
    const requiredInputs = (spec.inputs ?? []).filter((i) => i.required).length;
    if (images.length < requiredInputs) {
      throw new KlingProviderError(
        `模型 ${spec.model} 需要至少 ${requiredInputs} 张参考图`,
        "missing_references",
      );
    }
  }

  const traceId = newKlingTraceId();
  const args = buildKlingImageArgs({
    tool,
    spec,
    prompt: req.prompt,
    // 图片侧是 img_resolution（"1k"/"2k"/"4k"），与视频的 resolution 不同名不同值
    resolution: req.resolution,
    ratio: req.ratio,
    count: req.count,
    images,
    traceId,
  });

  console.log("[kling] submitImage", tool, JSON.stringify(args));

  const res = await execKlingCli(args, { timeoutMs: 180000 });
  if (!res.ok) throw cliFailure(res);

  const taskId = extractKlingGenerationId(res.data);
  if (!taskId) {
    throw new KlingProviderError("可灵提交响应缺少 generationId", "missing_task_id");
  }
  traceIds.set(taskId, traceId);

  return {
    taskId,
    creditsConsumed: extractKlingCredits(res.data),
    traceId,
  };
}

// ---------- 生成轮询 ----------

/** 轮询任务状态（`query_tasks <generationId>`） */
export async function queryTask(
  taskId: string,
  traceId?: string,
): Promise<KlingQueryResult> {
  const tid = traceId || traceIdFor(taskId);
  const res = await execKlingCli(buildKlingQueryArgs(taskId, tid), {
    timeoutMs: 60000,
  });
  if (!res.ok) throw cliFailure(res);

  const body = res.data as any;
  const status = mapKlingStatus(body?.status);
  const url = extractKlingResultUrl(body);
  const credits = extractKlingCredits(body);
  return {
    status,
    url,
    creditsConsumed: credits,
    error:
      status === "failed"
        ? extractKlingErrorMessage(body) || "可灵任务失败"
        : undefined,
  };
}

/**
 * 轮询**图片**任务状态（`query_tasks <generationId>`）。
 *
 * 与视频侧的 queryTask 有两处不同：
 *   - 结果地址取 urlWithoutWatermark 优先（图片带水印等于把水印烙进成片）
 *   - 返回**全部**地址（imageCount > 1 时服务端给多张）
 */
export async function queryImageTask(
  taskId: string,
  traceId?: string,
): Promise<KlingQueryResult> {
  const tid = traceId || traceIdFor(taskId);
  const res = await execKlingCli(buildKlingQueryArgs(taskId, tid), {
    timeoutMs: 60000,
  });
  if (!res.ok) throw cliFailure(res);

  const body = res.data as any;
  const status = mapKlingStatus(body?.status);
  const urls = extractKlingImageResultUrls(body);
  const credits = extractKlingCredits(body);
  return {
    status,
    url: urls[0],
    urls: urls.length ? urls : undefined,
    creditsConsumed: credits,
    error:
      status === "failed"
        ? extractKlingErrorMessage(body) || "可灵图片任务失败"
        : undefined,
  };
}

// ---------- 提交前检查 ----------

/** 余额不足提示（带服务端下发的充值链接，若有） */
export function rechargeHint(): string {
  const url = envState.rechargeUrl;
  return `可灵灵感值不足，请先充值${url ? `：${url}` : ""}`;
}

/**
 * 提交前的环境检查。
 *
 * ⚠️ **不阻塞提交余额为 0 的情况**：充值链接**只在服务端的错误响应里下发**
 * （`account` 不返回、CLI 里也没有硬编码），此时阻断会让用户无路可走 ——
 * 放行让服务端的拒绝把链接带回来更合理。
 */
export async function checkKlingReady(): Promise<{ ok: boolean; message: string }> {
  const modelsOk = await loadKlingModels();
  if (!modelsOk) {
    return {
      ok: false,
      message: envState.message || "可灵环境异常，无法提交",
    };
  }

  const credits = envState.credits;
  if (typeof credits === "number" && credits <= 0 && envState.rechargeUrl) {
    return { ok: false, message: rechargeHint() };
  }

  // 后台刷新真实余额（不 await —— 不能挡着提交）
  void refreshKlingAccount().catch((e) => {
    console.warn("[kling] 后台刷新余额失败:", e);
  });
  return { ok: true, message: "" };
}

// ---------- 错误转换 ----------

/** CLI 失败 → 可抛出的 provider 错误 */
function cliFailure(res: KlingCliExecResult): KlingProviderError {
  const raw = res.error || res.raw || "";
  if (
    res.code === "cli_not_installed" ||
    res.code === "not_logged_in" ||
    res.code === "node_not_found"
  ) {
    // 环境类错误：直接透传已有的人话提示
    return new KlingProviderError(raw, res.code, res.code);
  }
  const parsed = parseKlingError(raw, 0);
  if (parsed.type === "insufficient_credits") {
    const url = extractKlingRechargeUrl(parsed.message || "");
    if (url) patchEnv({ rechargeUrl: url });
  }
  return new KlingProviderError(
    friendlyKlingError(parsed, 0),
    parsed.type,
    res.code,
  );
}

export { KLING_PROVIDER_ID };
