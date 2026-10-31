/**
 * 本地媒体流服务（Node 层）
 *
 * 面板（Chromium）里 `<video>` / `<img>` 不能直接读本地文件：
 *   - 面板 origin 是扩展目录，file:// 直读受 CEF 的本地文件访问限制
 *   - CEP 12 起默认禁止 file:// 访问本地资源
 *
 * 所以 Node 层起一个只监听 127.0.0.1 的 HTTP 服务，带 Range 支持，
 * 把本地媒体喂给面板（docs 3.4 推荐的做法）。
 *
 * 安全：只服务**显式注册过**的文件，不做目录遍历。
 */
import { fs, http, path } from "../../lib/cep/node";

/** 注册表：id → 绝对路径 */
const files = new Map<string, string>();
let nextId = 1;

/** 已启动的 server 与端口 */
let server: any = null;
let port = 0;

/** MIME 类型（够用即可） */
function contentTypeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * CORS 头。
 *
 * 面板 origin（扩展目录 / dev server）与本服务（127.0.0.1:随机端口）不同源，
 * 面板侧要把视频帧画进 canvas 生成缩略图 —— 没有 CORS 头 canvas 会被污染，
 * `toDataURL()` 直接抛 SecurityError。
 *
 * 只监听 127.0.0.1 且只服务显式注册过的文件，放开 CORS 没有额外风险。
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

/** 启动服务（幂等） */
async function ensureServer(): Promise<number> {
  if (server && port) return port;

  server = http.createServer((req: any, res: any) => {
    try {
      const url = String(req.url || "");
      const m = /^\/m\/([A-Za-z0-9]+)$/.exec(url.split("?")[0]);
      if (!m) {
        res.writeHead(404, CORS_HEADERS);
        res.end();
        return;
      }
      const file = files.get(m[1]);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404, CORS_HEADERS);
        res.end();
        return;
      }

      const stat = fs.statSync(file);
      const total = stat.size;
      const type = contentTypeOf(file);
      const range = req.headers?.range;

      if (range) {
        const m2 = /bytes=(\d*)-(\d*)/.exec(String(range));
        const start = m2 && m2[1] ? parseInt(m2[1], 10) : 0;
        const end = m2 && m2[2] ? parseInt(m2[2], 10) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...CORS_HEADERS,
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": type,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      try {
        res.writeHead(500, CORS_HEADERS);
        res.end();
      } catch {
        // ignore
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
  return port;
}

/**
 * 注册一个本地媒体文件，返回面板可访问的 URL。
 *
 * 同一个文件重复注册会复用同一个 URL（按路径缓存）。
 */
const urlCache = new Map<string, string>();

export async function registerMedia(filePath: string): Promise<string> {
  if (!filePath) return "";
  const cached = urlCache.get(filePath);
  if (cached) return cached;
  const p = await ensureServer();
  const id = `f${nextId++}`;
  files.set(id, filePath);
  const url = `http://127.0.0.1:${p}/m/${id}`;
  urlCache.set(filePath, url);
  return url;
}

/** 停止服务（面板卸载时调用） */
export function stopMediaServer(): void {
  try {
    server?.close?.();
  } catch {
    // ignore
  }
  server = null;
  port = 0;
  files.clear();
  urlCache.clear();
}
