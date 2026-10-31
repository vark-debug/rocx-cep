/**
 * RunningHub 错误解析 + UI 友好消息
 * （对齐 UXP 版 providers/runninghub/errorMap.ts）
 */
import type { VideoGenErrorParsed } from "../core/types";

export function parseRunningHubError(
  raw: string,
  httpStatus: number,
): VideoGenErrorParsed {
  try {
    const j = JSON.parse(raw);
    return {
      type: j?.errorCode !== undefined ? String(j.errorCode) : j?.error?.type,
      message: j?.errorMessage || j?.error?.message || j?.message,
      httpCode: j?.httpCode ?? httpStatus,
    };
  } catch {
    return { type: `http_${httpStatus}`, message: raw.slice(0, 200), httpCode: httpStatus };
  }
}

export function friendlyRunningHubError(
  parsed: VideoGenErrorParsed | null,
  httpStatus: number,
): string {
  const t = parsed?.type;
  if (t === "1001") return "RunningHub：参数缺失或无效（1001）— 请检查请求参数";
  if (t === "1003") return "RunningHub：API Key 无效（1003）— 请检查 API Token";
  if (t === "1007") return "RunningHub：无法识别参考图（1007）— 请换用抓帧产物重新上传";
  if (httpStatus === 401 || httpStatus === 403) {
    return `鉴权失败（${httpStatus}）— RunningHub API Token 无效或过期`;
  }
  if (httpStatus === 429) return "触发限流（429）— 请稍后再试";
  if (httpStatus >= 500) return `RunningHub 服务端错误（${httpStatus}）— 请稍后再试`;
  if (parsed?.message) {
    return `RunningHub 请求失败（${httpStatus}）：${parsed.message}`;
  }
  return `RunningHub 请求失败（${httpStatus}）`;
}
