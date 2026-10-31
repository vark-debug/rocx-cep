/**
 * Ark（火山方舟）错误解析 + UI 友好消息
 * （对齐 UXP 版 providers/ark/errorMap.ts）
 */
import type { VideoGenErrorParsed } from "../core/types";

export function parseArkError(raw: string, httpStatus: number): VideoGenErrorParsed {
  try {
    const j = JSON.parse(raw);
    return {
      type: j?.error?.type || j?.code,
      message: j?.error?.message || j?.message,
      httpCode: j?.error?.http_code ?? httpStatus,
      requestId: j?.request_id || j?.id,
    };
  } catch {
    return { type: `http_${httpStatus}`, message: raw.slice(0, 200), httpCode: httpStatus };
  }
}

export function friendlyArkError(
  parsed: VideoGenErrorParsed | null,
  httpStatus: number,
): string {
  const t = String(parsed?.type ?? "");
  if (httpStatus === 401 || t.includes("authentication")) {
    return "鉴权失败（401）— 火山方舟 API Key 无效，请检查模型接入点与 Key";
  }
  if (httpStatus === 403 || t.includes("AccessDenied")) {
    return "无权访问（403）— 请确认已在火山方舟开通该模型并授权";
  }
  if (httpStatus === 429 || t.includes("Throttl")) {
    return "触发限流（429）— 请稍后再试";
  }
  if (t.includes("InvalidParameter")) {
    return `参数错误 — ${parsed?.message || "请检查尺寸/模型参数"}`;
  }
  if (httpStatus >= 500) return `火山方舟服务端错误（${httpStatus}）— 请稍后再试`;
  if (parsed?.message) {
    return `火山方舟请求失败（${httpStatus}）：${parsed.message}`;
  }
  return `火山方舟请求失败（${httpStatus}）`;
}
