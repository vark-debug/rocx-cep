/**
 * 本地图片读取（Node 层）
 *
 * 抓帧产物是本地 PNG —— 面板要显示缩略图有两条路：
 *   1. 走 mediaServer 的 http 流（省内存，但多一次请求）
 *   2. 直接读成 data URL（一帧 PNG 几百 KB，够用且实现简单）
 *
 * 这里提供第 2 条。生成记录的缩略图在落盘时会被剥离（base64 会让 JSON 膨胀），
 * 面板按需实时读。
 */
import { fs } from "../../lib/cep/node";

/** MIME 类型 */
function mimeOf(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/** 读本地图片为 data URL；失败返回空串 */
export function readImageDataUrl(filePath: string): string {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const buf = fs.readFileSync(filePath);
    return `data:${mimeOf(filePath)};base64,${buf.toString("base64")}`;
  } catch (e) {
    console.warn("[image] 读取失败:", filePath, e);
    return "";
  }
}
