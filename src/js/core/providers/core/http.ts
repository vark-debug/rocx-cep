/**
 * Node 层 HTTP 工具（provider 共用）
 *
 * CEP 内嵌 node v22 / 系统链 node>=18，全局 fetch 可用（undici）。
 * 与 UXP 版的差异：Node 层直接 fs 读文件构造 multipart，无需 fileToken。
 *
 * ⚠ Node 模块必须经 lib/cep/node 取（面板与 Node 同 bundle，
 *   直接 import "node:fs" 会被 vite 外置成 browser-external 导致运行期炸）。
 */
import { fs, path } from "../../../lib/cep/node";
import type { VideoGenErrorParsed } from "./types";

export interface HttpTextResult {
  status: number;
  ok: boolean;
  text: string;
}

export interface HttpJsonResult extends HttpTextResult {
  json: any;
}

/** 网络层错误 → VideoGenError 的 errorType 统一取值 */
export const NETWORK_ERROR_TYPE = "network_error";

/** 统一把 fetch 异常转成可读信息 */
export function networkErrorMessage(e: unknown): string {
  const msg = String((e as any)?.message || e);
  // undici 的 cause 里常有根因（ECONNREFUSED / ENOTFOUND / 证书）
  const cause = String((e as any)?.cause?.message || "");
  return cause && cause !== msg ? `${msg}（${cause}）` : msg;
}

/** POST JSON → 文本结果（不抛 HTTP 错误，由调用方按 status 分流） */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<HttpTextResult> {
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, ok: r.ok, text: await r.text() };
}

/** GET → 文本结果 */
export async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<HttpJsonResult> {
  const r = await fetch(url, { method: "GET", headers });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 保留 null */
  }
  return { status: r.status, ok: r.ok, text, json };
}

/** 按扩展名猜 MIME（对齐 UXP common.guessContentType） */
export function guessContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  return (
    (
      {
        mp4: "video/mp4",
        mov: "video/quicktime",
        wav: "audio/wav",
        mp3: "audio/mpeg",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        heic: "image/heic",
        heif: "image/heif",
      } as Record<string, string>
    )[ext] || "application/octet-stream"
  );
}

export interface MultipartFilePart {
  fieldName: string;
  fileName: string;
  /** 本地绝对路径（Node 层直接读盘） */
  localPath: string;
  contentType?: string;
}

/**
 * 上传 multipart/form-data（fs 读文件 + 手工拼 boundary）。
 * 返回文本结果；调用方按 status 与业务码分流。
 */
export async function postMultipart(
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
  file: MultipartFilePart,
): Promise<HttpTextResult> {
  const buf = await fs.promises.readFile(file.localPath);
  const boundary = "----RocXFormBoundary" + Math.random().toString(36).slice(2);
  const crlf = "\r\n";
  const parts: Buffer[] = [];

  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`,
        "utf-8",
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}${crlf}Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"${crlf}Content-Type: ${
        file.contentType || guessContentType(file.fileName)
      }${crlf}${crlf}`,
      "utf-8",
    ),
  );
  parts.push(buf);
  parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf-8"));

  const r = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts) as unknown as BodyInit,
  });
  return { status: r.status, ok: r.ok, text: await r.text() };
}

/** 本地文件大小（字节）；不存在返回 0 */
export function fileSizeOf(localPath: string): number {
  try {
    return fs.statSync(localPath).size;
  } catch {
    return 0;
  }
}

/**
 * 本地文件 → base64 data URI（图生图直传：RunningHub / Ark）。
 * MIME 按扩展名推断。
 */
export async function fileToDataUri(
  localPath: string,
): Promise<string> {
  const buf = await fs.promises.readFile(localPath);
  const mime = guessContentType(path.basename(localPath));
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 截断错误正文（日志与错误信息里避免刷屏） */
export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把 HTTP !ok 的响应体解析成 VideoGenErrorParsed（provider.parseError 的通用兜底）。
 * 各 provider 的私有解析失败时用它兜底。
 */
export function fallbackErrorParse(
  rawText: string,
  httpStatus: number,
): VideoGenErrorParsed {
  try {
    const j = JSON.parse(rawText);
    return {
      type: j?.error?.type || j?.code || `http_${httpStatus}`,
      message: j?.error?.message || j?.message || truncate(rawText),
      httpCode: httpStatus,
    };
  } catch {
    return {
      type: `http_${httpStatus}`,
      message: truncate(rawText) || `HTTP ${httpStatus}`,
      httpCode: httpStatus,
    };
  }
}
