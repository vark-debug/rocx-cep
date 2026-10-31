/**
 * MiniMax provider：视频生成（对齐 UXP 版 MiniMaxProvider，Node 层化）
 *
 * - createVideo：POST /v2/video_generation（content 数组 + mm_file:// 引用）
 * - queryTask：GET /v2/query/video_generation/<taskId>
 * - regenerateVideo：POST /v2/video_regeneration（H3 专属，分辨率升级）
 * - submitOptimizePrompt：POST /v2/h3_context_ir（H3 专属，提示词优化）
 * - uploadFile：POST /v1/files/upload（multipart）→ file_id（int64 必须归一化成 string）
 */
import type {
  ProviderModelDescriptor,
  ProviderRef,
  ProviderUploadRequest,
  ProviderUploadResult,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenErrorParsed,
  VideoGenProvider,
  VideoGenQueryResponse,
} from "../core/contracts";
import { VideoGenError } from "../core/errors";
import {
  fileSizeOf,
  getJson,
  networkErrorMessage,
  NETWORK_ERROR_TYPE,
  postJson,
  postMultipart,
} from "../core/http";
import { dryRunCreateResponse, isDryRun } from "../core/dryRun";
import { parseMiniMaxError, friendlyMiniMaxError } from "./errorMap";
import { buildContent, warnIfContainsBase64 } from "./wireFormat";

const CREATE_URL = "https://api.minimax.cn/v2/video_generation";
const QUERY_BASE = "https://api.minimax.cn/v2/query/video_generation";
const REGENERATE_URL = "https://api.minimax.cn/v2/video_regeneration";
const H3_CONTEXT_IR_URL = "https://api.minimax.cn/v2/h3_context_ir";
const UPLOAD_URL = "https://api.minimax.cn/v1/files/upload";
const UPLOAD_PURPOSE = "video_generation_input";

export const MINIMAX_MODEL_LIST: ProviderModelDescriptor[] = [
  {
    providerId: "minimax",
    modelId: "MiniMax-H3",
    displayName: "H3 标准",
    description: "MiniMax H3 标准模型，支持多档分辨率与时长",
    paramConstraints: {
      resolutions: ["768P", "2K"],
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      ratioAdaptiveAllowed: true,
    },
    capabilities: [
      "videoGeneration",
      "imageReference",
      "videoReference",
      "audioReference",
      "resolutionUpscale", // video_regeneration 仅 H3 支持
      "promptOptimization", // h3_context_ir 仅 H3 支持
    ],
  },
  {
    providerId: "minimax",
    modelId: "MiniMax-H3-Max",
    displayName: "H3-Max 极速",
    description: "MiniMax H3 极速模型，480P/768P",
    paramConstraints: {
      resolutions: ["480P", "768P"],
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      ratioAdaptiveAllowed: true,
    },
    capabilities: [
      "videoGeneration",
      "imageReference",
      "videoReference",
      "audioReference",
    ],
  },
];

export class MiniMaxProvider implements VideoGenProvider {
  readonly providerId = "minimax";
  readonly displayName = "MiniMax（海螺 AI）";
  readonly models = MINIMAX_MODEL_LIST;

  buildAuthHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  parseError(rawText: string, _httpStatus: number): VideoGenErrorParsed {
    return parseMiniMaxError(rawText) || {};
  }

  friendlyErrorMessage(parsed: VideoGenErrorParsed, httpStatus: number): string {
    return friendlyMiniMaxError(parsed, httpStatus);
  }

  /** 上传素材 → mm_file:// 引用用的 file_id */
  async uploadFile(req: ProviderUploadRequest): Promise<ProviderUploadResult> {
    try {
      const size = fileSizeOf(req.localPath);
      if (!size) return { ok: false, error: `文件不可读: ${req.localPath}` };
      console.log(
        `[minimax-upload] POST ${UPLOAD_URL} file="${req.fileName}" bytes=${size}`,
      );

      const r = await postMultipart(
        UPLOAD_URL,
        { Authorization: `Bearer ${req.apiKey}` },
        { purpose: UPLOAD_PURPOSE },
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
      const json = JSON.parse(r.text) as {
        // ⚠ MiniMax 的 file_id 是 int64，JSON 里是**数字**。
        // 必须归一化成 string：下游的 .trim() 等字符串方法按 string 用。
        file?: { file_id?: string | number };
        base_resp?: { status_code?: number; status_msg?: string };
      };
      const statusCode = json?.base_resp?.status_code ?? 0;
      if (statusCode !== 0) {
        return {
          ok: false,
          error: json?.base_resp?.status_msg || `base_resp.status_code=${statusCode}`,
        };
      }
      const rawFileId = json?.file?.file_id;
      if (rawFileId === undefined || rawFileId === null || rawFileId === "") {
        return { ok: false, error: "响应缺少 file_id" };
      }
      return { ok: true, fileId: String(rawFileId) };
    } catch (e) {
      return { ok: false, error: String((e as any)?.message || e) };
    }
  }

  async createVideo(
    req: VideoGenCreateRequest,
    apiKey: string,
  ): Promise<VideoGenCreateResponse> {
    if (isDryRun()) {
      const content = buildContent(req.prompt, req.references).map((c) =>
        c.type === "text"
          ? c
          : {
              ...c,
              [c.type]: { url: `${c[c.type]?.url} (dry-run 保留语法未发送)` },
            },
      );
      console.log(
        `%c[MiniMax createVideo dry-run]`,
        "color:#5cb85c;font-weight:bold",
        "\nURL:", CREATE_URL,
        "\nBody:", JSON.stringify(
          { model: req.model, content, resolution: req.resolution, duration: req.duration },
          null,
          2,
        ),
      );
      return dryRunCreateResponse("minimax.createVideo");
    }

    const content = buildContent(req.prompt, req.references);
    const body: any = {
      model: req.model,
      content,
      resolution: req.resolution,
      duration: req.duration,
    };
    if (req.references.length === 0) {
      body.ratio = req.ratio === "adaptive" ? "16:9" : req.ratio;
    } else {
      body.ratio = req.ratio;
    }
    const bodyString = JSON.stringify(body);
    warnIfContainsBase64(bodyString, "createVideo");

    let r;
    try {
      r = await postJson(CREATE_URL, this.buildAuthHeaders(apiKey), body);
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
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = JSON.parse(r.text) as {
      task_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 响应缺少 task_id", {
        errorType: "missing_task_id",
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }

  async queryTask(taskId: string, apiKey: string): Promise<VideoGenQueryResponse> {
    const r = await getJson(`${QUERY_BASE}/${taskId}`, this.buildAuthHeaders(apiKey));
    if (!r.ok) {
      throw new VideoGenError(
        `MiniMax 查询失败 (${r.status}): ${r.text.slice(0, 200)}`,
        { httpStatus: r.status, errorType: "http_error", providerId: this.providerId },
      );
    }
    // 官方响应：{ task: { id, status, content: { url }, ... }, request_id, base_resp }
    const j = r.json as {
      task?: any;
      request_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    const task = j?.task || j;
    return {
      status: task.status,
      content: task.content,
      error: task.error,
      usage: task.usage,
      raw: j,
    };
  }

  async regenerateVideo(args: {
    sourceTaskId: string;
    resolution: string;
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse> {
    if (isDryRun()) return dryRunCreateResponse("minimax.regenerateVideo");

    const model = args.model || "MiniMax-H3";
    const body = {
      model,
      source_task_id: args.sourceTaskId,
      resolution: args.resolution,
    };
    let r;
    try {
      r = await postJson(REGENERATE_URL, this.buildAuthHeaders(args.apiKey), body);
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
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = JSON.parse(r.text) as { task_id?: string };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 像素提升响应缺少 task_id", {
        errorType: "missing_task_id",
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }

  async submitOptimizePrompt(args: {
    prompt: string;
    duration: number;
    ratio: string;
    references?: ProviderRef[];
    model?: string;
    apiKey: string;
  }): Promise<VideoGenCreateResponse> {
    if (isDryRun()) return dryRunCreateResponse("minimax.submitOptimizePrompt");

    const model = args.model || "MiniMax-H3";
    const refs = args.references || [];
    const content = buildContent(args.prompt, refs);
    const body: any = {
      model,
      content,
      duration: args.duration,
      ratio: args.ratio,
    };
    const bodyString = JSON.stringify(body);
    warnIfContainsBase64(bodyString, "submitOptimizePrompt");

    let r;
    try {
      r = await postJson(H3_CONTEXT_IR_URL, this.buildAuthHeaders(args.apiKey), body);
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
        requestId: parsed.requestId,
        providerId: this.providerId,
      });
    }
    const j = JSON.parse(r.text) as { task_id?: string; request_id?: string };
    if (!j.task_id) {
      throw new VideoGenError("MiniMax 提示词优化响应缺少 task_id", {
        errorType: "missing_task_id",
        requestId: j.request_id,
        providerId: this.providerId,
      });
    }
    return { taskId: j.task_id, raw: j };
  }
}
