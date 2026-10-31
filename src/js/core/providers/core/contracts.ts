/**
 * Provider 契约（对齐 UXP 版 VideoGenProvider / ImageGenProvider，
 * 并把 host 侧 UxPProvider 的 uploadFile 并入 —— CEP 无跨进程边界，
 * 上传与提交都由同一 provider 实现承担）
 *
 * 智能路由约定：是否走 image-to-image / image-to-video 由 provider
 * 实现内部依据请求的 references（及 referencesDataUris）决定。
 */
import type {
  ImageGenCreateRequest,
  ProviderModelDescriptor,
  ProviderRef,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenErrorParsed,
  VideoGenQueryResponse,
} from "./types";

// 契约实现方统一从本模块取全部类型（requests / responses / descriptors）
export type {
  ImageGenCreateRequest,
  ProviderCapability,
  ProviderModelDescriptor,
  ProviderParamConstraints,
  ProviderRef,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenErrorParsed,
  VideoGenQueryResponse,
} from "./types";

/** 素材上传请求（Node 层直接读 localPath，无需 fileToken） */
export interface ProviderUploadRequest {
  apiKey: string;
  /** 本地绝对路径 */
  localPath: string;
  fileName: string;
  contentType?: string;
}

export interface ProviderUploadResult {
  ok: boolean;
  /** provider 侧引用标识（MiniMax file_id / RunningHub fileName / Ark inline:<name>） */
  fileId?: string;
  error?: string;
}

export interface ProviderBase {
  /** provider 唯一 id，如 "minimax" / "kling" */
  readonly providerId: string;
  /** provider 展示名 */
  readonly displayName: string;
  /** 此 provider 提供的模型列表（含 capability） */
  readonly models: ProviderModelDescriptor[];
  /** 生成鉴权头 */
  buildAuthHeaders(apiKey: string): Record<string, string>;
  /** 解析错误响应（HTTP !ok 时调用） */
  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed;
  /** 错误码 → UI 友好消息（含 provider 私有错误码） */
  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string;
  /**
   * 素材上传（可选）。
   * - MiniMax：POST files/upload（multipart）→ file_id
   * - RunningHub：POST media/upload/binary → fileName
   * - Ark：no-op（提交时 base64 内联），返回 "inline:<fileName>"
   * - 可灵：无需上传（CLI 自带素材直传），不实现
   */
  uploadFile?(req: ProviderUploadRequest): Promise<ProviderUploadResult>;
}

export interface VideoGenProvider extends ProviderBase {
  /** 提交视频生成任务，返回 taskId */
  createVideo(
    req: VideoGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse>;
  /** 查询任务状态 */
  queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse>;
  /** 可选：分辨率升级（如 MiniMax video_regeneration） */
  regenerateVideo?(args: {
    sourceTaskId: string;
    resolution: string;
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse>;
  /** 可选：提示词优化（如 MiniMax h3_context_ir） */
  submitOptimizePrompt?(args: {
    prompt: string;
    duration: number;
    ratio: string;
    references?: ProviderRef[];
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse>;
}

export interface ImageGenProvider extends ProviderBase {
  /**
   * 同步生成型 provider（如 Ark：createImage 内部直接等待出图，无 taskId/轮询）。
   * 为 true 时提交记录直接进入 generating 状态，跳过 pending(排队) 阶段。
   */
  readonly syncGeneration?: boolean;
  /** 提交图片生成任务（内部按 references 有无路由 text-to-image / image-to-image） */
  createImage(
    req: ImageGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse>;
  /** 查询任务状态（succeeded 时 content.url 为产物地址） */
  queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse>;
}

/** Provider 自身支持的 capability 集合（聚合自 models） */
export function providerCapabilities(
  p: ProviderBase,
): Set<string> {
  const set = new Set<string>();
  for (const m of p.models) for (const c of m.capabilities) set.add(c);
  return set;
}

/** 参考素材类型收窄工具（视频 provider 只吃合法类型） */
export function isProviderRef(x: unknown): x is ProviderRef {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as ProviderRef).localPath === "string"
  );
}
