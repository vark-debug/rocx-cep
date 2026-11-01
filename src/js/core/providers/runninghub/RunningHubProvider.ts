/**
 * RunningHub provider：图片生成（对齐 UXP 版 RunningHubProvider，Node 层化）
 *
 * 智能路由（API 无服务端路由）：
 * - referencesDataUris 为空 → /seedream-v5-pro/text-to-image（文生图）
 * - 非空 → /seedream-v5-pro/image-to-image（imageUrls 必填，Base64 data URI；
 *   外链 download_url / 纯文件名引用均报 1007，实测弃用）
 *
 * wire format（官方示例）：
 * - create: POST { prompt, width, height, outputFormat } → { taskId, status: "RUNNING" }
 * - query:  POST { taskId } → { status: "SUCCESS"|"RUNNING"|"QUEUED"|"FAILED",
 *   results: [{ url, nodeId, outputType }], errorMessage }
 */
import type {
  ImageGenCreateRequest,
  ProviderModelDescriptor,
  ProviderUploadRequest,
  ProviderUploadResult,
  VideoGenCreateResponse,
  VideoGenErrorParsed,
  VideoGenQueryResponse,
  ImageGenProvider,
} from "../core/contracts";
import { VideoGenError } from "../core/errors";
import {
  fileSizeOf,
  networkErrorMessage,
  NETWORK_ERROR_TYPE,
  postJson,
  postMultipart,
} from "../core/http";
import { dryRunCreateResponse, isDryRun } from "../core/dryRun";
import { parseRunningHubError, friendlyRunningHubError } from "./errorMap";

const TEXT_TO_IMAGE_URL =
  "https://www.runninghub.cn/openapi/v2/seedream-v5-pro/text-to-image";
const IMAGE_TO_IMAGE_URL =
  "https://www.runninghub.cn/openapi/v2/seedream-v5-pro/image-to-image";
const QUERY_URL = "https://www.runninghub.cn/openapi/v2/query";
const UPLOAD_URL = "https://www.runninghub.cn/openapi/v2/media/upload/binary";

export const RUNNINGHUB_MODEL_LIST: ProviderModelDescriptor[] = [
  {
    providerId: "runninghub",
    modelId: "seedream-v5-pro",
    displayName: "Seedream 5.0 Pro",
    description: "RunningHub Seedream V5 Pro 文生图，单次 1 张，最高 2K",
    paramConstraints: {
      resolutions: ["1K", "2K"],
      durations: [],
      ratios: ["1:1", "4:3", "3:4", "16:9", "9:16"],
      ratioAdaptiveAllowed: false,
    },
    // 图生图链路：referencesDataUris 非空时路由到 image-to-image（imageUrls=dataUris）
    capabilities: ["imageGeneration", "imageReference"],
  },
];

export class RunningHubProvider implements ImageGenProvider {
  readonly providerId = "runninghub";
  readonly displayName = "RunningHub";
  readonly models = RUNNINGHUB_MODEL_LIST;

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  parseError(rawText: string, httpStatus: number): VideoGenErrorParsed {
    return parseRunningHubError(rawText, httpStatus);
  }

  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string {
    return friendlyRunningHubError(parsed, httpStatus);
  }

  /**
   * 素材上传 → fileName（如 "openapi/xxx.png"）。
   * fileId 存 fileName 而非 download_url：图生图 imageUrls 用 RH input
   * 纯文件名引用（ComfyUI 原生格式，不受 24h 签名过期限制）；
   * COS 预签名直链会触发「图片链接无效或无法识别」。
   */
  async uploadFile(req: ProviderUploadRequest): Promise<ProviderUploadResult> {
    try {
      const size = fileSizeOf(req.localPath);
      if (!size) return { ok: false, error: `文件不可读: ${req.localPath}` };
      console.log(
        `[runninghub-upload] POST ${UPLOAD_URL} file="${req.fileName}" bytes=${size}`,
      );

      const r = await postMultipart(
        UPLOAD_URL,
        { Authorization: `Bearer ${req.apiKey}` },
        {},
        {
          fieldName: "file",
          fileName: req.fileName,
          localPath: req.localPath,
          contentType: req.contentType,
        },
      );
      if (!r.ok) {
        return { ok: false, error: `HTTP ${r.status} ${r.text.slice(0, 200)}` };
      }
      let json: {
        code?: number;
        message?: string;
        data?: { download_url?: string; fileName?: string; msg?: string };
      };
      try {
        json = JSON.parse(r.text);
      } catch {
        return { ok: false, error: `响应非 JSON: ${r.text.slice(0, 200)}` };
      }
      if (json.code !== 0) {
        const err = json.message || json.data?.msg || `code=${json.code}`;
        console.warn(`[runninghub-upload] 业务失败: ${err}`);
        return { ok: false, error: err };
      }
      const downloadUrl = json.data?.download_url;
      const fileName = json.data?.fileName;
      if (!downloadUrl || !fileName) {
        return { ok: false, error: "响应缺少 data.download_url/fileName" };
      }
      console.log(
        `[runninghub-upload] ✅ 上传成功 fileName=${fileName} download_url=${downloadUrl}`,
      );
      return { ok: true, fileId: fileName };
    } catch (e) {
      return { ok: false, error: String((e as any)?.message || e) };
    }
  }

  async createImage(
    req: ImageGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    // 智能路由：有参考图 data URI → image-to-image；无 → text-to-image
    const dataUris = req.referencesDataUris ?? [];
    const hasReferences = dataUris.length > 0;
    const endpoint = hasReferences ? IMAGE_TO_IMAGE_URL : TEXT_TO_IMAGE_URL;

    const model = this.models.find((m) => m.modelId === req.model);
    if (!model || !model.capabilities.includes("imageGeneration")) {
      throw new VideoGenError(`未知图片模型: ${req.model}`, {
        errorType: "unknown_model",
        providerId: this.providerId,
      });
    }

    // width/height 由上层算好直传（智能档=序列分辨率 / 预设档=ratioToSize）；
    // 单次仅 1 张（count>1 由上层拆多任务，当前 UI 固定 1）
    const body = {
      prompt: req.prompt,
      width: Math.round(req.width),
      height: Math.round(req.height),
      outputFormat: req.outputFormat,
      ...(hasReferences ? { imageUrls: dataUris } : {}),
    };

    if (isDryRun()) {
      // 日志截断 base64 内容，避免刷爆控制台
      const bodyPreview = JSON.stringify(body, (_k, v) =>
        typeof v === "string" && v.startsWith("data:")
          ? `${v.slice(0, 48)}...<base64 ${v.length} chars>`
          : v,
      );
      console.log(
        `%c[RunningHub createImage dry-run]`,
        "color:#5cb85c;font-weight:bold",
        "\nURL:", endpoint,
        "\nRoute:", hasReferences ? "image-to-image (base64)" : "text-to-image",
        "\nBody:", bodyPreview,
      );
      return dryRunCreateResponse("runninghub.createImage");
    }

    let r;
    try {
      r = await postJson(endpoint, this.buildAuthHeaders(apiKey), body);
    } catch (e) {
      throw new VideoGenError("网络错误: " + networkErrorMessage(e), {
        httpStatus: 0,
        errorType: NETWORK_ERROR_TYPE,
        providerId: this.providerId,
      });
    }
    if (!r.ok) {
      const parsed = this.parseError(r.text, r.status);
      throw new VideoGenError(this.friendlyErrorMessage(parsed, r.status), {
        httpStatus: r.status,
        errorType: parsed.type || "http_error",
        providerId: this.providerId,
      });
    }
    const j = JSON.parse(r.text) as {
      taskId?: string;
      errorCode?: string | number;
      errorMessage?: string;
    };
    // RunningHub 提交失败也可能 HTTP 200（errorCode 非空）
    if (!j.taskId) {
      const parsed: VideoGenErrorParsed = {
        type: j.errorCode ? String(j.errorCode) : undefined,
        message: j.errorMessage,
        httpCode: r.status,
      };
      throw new VideoGenError(
        this.friendlyErrorMessage(parsed, r.status),
        { errorType: "missing_task_id", providerId: this.providerId },
      );
    }
    return { taskId: j.taskId, raw: j };
  }

  async queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse> {
    const r = await postJson(
      QUERY_URL,
      this.buildAuthHeaders(apiKey),
      { taskId },
    );
    if (!r.ok) {
      throw new VideoGenError(
        `RunningHub 查询失败 (${r.status}): ${r.text.slice(0, 200)}`,
        { httpStatus: r.status, errorType: "http_error", providerId: this.providerId },
      );
    }
    const j = JSON.parse(r.text) as {
      taskId?: string;
      status?: string;
      errorMessage?: string;
      failedReason?: Record<string, unknown> | null;
      usage?: Record<string, unknown>;
      results?: Array<{ url?: string; nodeId?: string; outputType?: string }> | null;
    };
    const url = j.results && j.results.length > 0 ? j.results[0]?.url : undefined;
    return {
      status: mapStatus(j.status),
      content: url ? { url } : undefined,
      error:
        j.status === "FAILED" || j.status === "CANCELLED"
          ? { message: j.errorMessage || "任务失败" }
          : undefined,
      usage: j.usage,
      raw: j,
    };
  }
}

/** RunningHub 状态 → 中性状态 */
function mapStatus(s?: string): VideoGenQueryResponse["status"] {
  switch (s) {
    case "SUCCESS":
      return "succeeded";
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      // 未知状态按失败处理，避免无限轮询
      return "failed";
  }
}
