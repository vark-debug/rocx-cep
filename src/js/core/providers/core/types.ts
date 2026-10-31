/**
 * Provider 抽象层共享类型（对齐 RocX UXP 版 webview-ui/src/providers/core/types.ts）
 *
 * 与 UXP 版的差异：
 *   - ReferenceItem → 直接复用 shared/types.ts 的 GenerationReference /
 *     KlingReferenceInput（CEP 侧单一引用类型，kling 直链字段保留）
 *   - referencesDataUris 保留：RunningHub / Ark 图生图以 base64 data URI 直传，
 *     由 Node 层提交前从 references 的 localPath 读取转换
 */

// 通用视频创建请求（不同 provider 在内部映射到各自的 wire format）
export interface VideoGenCreateRequest {
  /** provider-specific model id */
  model: string;
  prompt: string;
  /** "16:9" | "adaptive" 等通用值 */
  ratio: string;
  /** 秒 */
  duration: number;
  /** "768P" | "2K" 等 */
  resolution: string;
  references: ProviderRef[];
}

// provider 模型描述符（含参数约束与能力位）
export interface ProviderModelDescriptor {
  providerId: string;
  modelId: string;
  displayName: string;
  description?: string;
  paramConstraints: ProviderParamConstraints;
  capabilities: ProviderCapability[];
}

// 通用参数约束
export interface ProviderParamConstraints {
  resolutions: string[];
  durations: number[];
  /** 模型支持的画面比例集（含 "adaptive" 表示参考场景也可选） */
  ratios: string[];
  /** 已废弃，留作兼容：等价于 ratios 包含 "adaptive" */
  ratioAdaptiveAllowed: boolean;
  /** 服务端声明的默认分辨率档位（可选，仅可灵图片用） */
  defaultResolution?: string;
  /** 服务端声明的默认宽高比（可选，同上） */
  defaultRatio?: string;
}

// 能力位
export type ProviderCapability =
  | "videoGeneration"
  | "imageGeneration"
  | "promptOptimization"
  | "resolutionUpscale"
  | "imageReference"
  | "videoReference"
  | "audioReference";

// 通用图片创建请求（provider 内部映射到各自 wire format）
export interface ImageGenCreateRequest {
  /** provider-specific model id，如 "seedream-v5-pro" */
  model: string;
  prompt: string;
  /** "1:1" | "16:9" 等（仅展示/记录用；像素由 width/height 决定） */
  ratio: string;
  /** 输出像素宽（Int）；智能档 = 活动序列分辨率，预设档 = ratioToSize 映射 */
  width: number;
  /** 输出像素高（Int） */
  height: number;
  /** 输出格式："jpeg" | "png" */
  outputFormat: string;
  /**
   * provider 原生的分辨率档位（可选）。
   * 可灵图片用服务端声明的 img_resolution（"1k"/"2k"/"4k"），与像素语义不同；
   * 其余 provider 不需要（width/height 已是权威）。
   */
  resolutionTier?: string;
  /** 张数（RunningHub 单次仅出 1 张） */
  count: number;
  /** 有参考图 → image-to-image 路由；无 → text-to-image */
  references: ProviderRef[];
  /**
   * 参考图内容（data:image/...;base64, 完整 data URI），图生图直传用。
   * RunningHub 对外链 / 纯文件名引用校验不稳（1007），Base64 data URI
   * 是官方支持的直传形式。由提交链路从 references 的 localPath 读取生成。
   */
  referencesDataUris?: string[];
}

// provider 操作结果（最小集）
export interface VideoGenCreateResponse {
  taskId: string;
  /** 本次实扣的灵感值（仅可灵有） */
  creditsConsumed?: number;
  raw?: unknown;
}

export interface VideoGenQueryResponse {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  content?: { url?: string; prompt?: string };
  error?: { message: string; httpCode?: number };
  usage?: Record<string, unknown>;
  raw?: unknown;
}

export interface VideoGenErrorParsed {
  type?: string;
  message?: string;
  httpCode?: string | number;
  requestId?: string;
}

/**
 * 提交链路的参考素材引用（provider 无关）。
 *
 * 与 KlingReferenceInput 的关系：同形状 + uploadProvider 归属。
 * fileId 是 **provider 侧**的引用标识（MiniMax file_id / RunningHub fileName /
 * Ark "inline:<name>"），由各 provider 的 uploadFile 产生。
 */
export interface ProviderRef {
  type: "reference_image" | "reference_video" | "reference_audio";
  /** 本地绝对路径 */
  localPath: string;
  fileName?: string;
  sizeBytes?: number;
  /** provider 侧引用标识（上传产物） */
  fileId?: string;
  /** fileId 归属的 provider id；缺省视为提交时的 provider */
  uploadProvider?: string;
  uploadedAt?: string;
}
