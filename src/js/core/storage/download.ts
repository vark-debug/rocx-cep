/**
 * 结果文件下载（Node 层）
 *
 * 可灵返回的是 CDN 直链（可灵 CDN / OSS），需要下载到本地再导入 Premiere。
 * 面板层不能直接 fetch（跨域 + 无 fs），所以下载放在 Node 层用 https 模块做。
 *
 * 要点：
 *   - 跟随 3xx 跳转（OSS 直链通常会 302 到实际对象）
 *   - 流式落盘，不把整个视频读进内存
 *   - 超时兜底，避免面板一直挂在「下载中」
 */
import { fs, http, https, path } from "../../lib/cep/node";

/** 最多跟随的跳转次数 */
const MAX_REDIRECTS = 5;

export interface DownloadResult {
  ok: boolean;
  error?: string;
  /** 落盘路径 */
  path?: string;
  /** 字节数 */
  bytes?: number;
  contentType?: string;
}

interface DownloadOptions {
  /** 超时（毫秒），默认 180s */
  timeoutMs?: number;
}

/** 文件名主干的最大长度（字节） */
const MAX_NAME_STEM = 120;

/**
 * 从 Content-Disposition / URL 里猜一个文件名
 *
 * @param contentType 已知的内容类型（可选）。
 *   URL 最后一段没有扩展名时用它补后缀 —— 可灵图片的 CDN 直链
 *   （如 p4-fdl.klingai.com）常常不带后缀，缺了后缀 Premiere 认不出是图片。
 *   不传就保持原样（老行为，避免给视频文件换上错误的 .bin 后缀）。
 */
export function guessFileName(url: string, contentType?: string): string {
  let name = "";
  try {
    const clean = url.split("?")[0].split("#")[0];
    const segs = clean.split("/");
    name = decodeURIComponent(segs[segs.length - 1] || "");
  } catch {
    name = "";
  }
  // URL 最后一段没有扩展名 → 按 contentType 补后缀
  if (!name) {
    name = `download${extOfContentType(contentType)}`;
  } else if (contentType && !/\.[A-Za-z0-9]{1,5}$/.test(name)) {
    const stem = name.replace(/\.[^.]*$/, "") || "download";
    name = `${stem}${extOfContentType(contentType)}`;
  }
  // 去掉路径分隔符等非法字符
  name = name.replace(/[\\/:*?"<>|]/g, "_");
  return truncateName(name);
}

/**
 * 截断过长的文件名。
 *
 * ⚠ 可灵图片 CDN 直链的最后一段是一长串签名 token（实测 300+ 字符），
 *   直接当文件名会撞上文件系统 255 字节上限（macOS: ENAMETOOLONG），
 *   下载全部失败。截断主干保留扩展名即可 —— 重名由 uniqueFilePath 兜底。
 */
function truncateName(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  if (stem.length <= MAX_NAME_STEM) return name;
  return stem.slice(0, MAX_NAME_STEM) + ext;
}

/** content type → 文件后缀（认不出来时返回 ".bin"） */
function extOfContentType(contentType?: string): string {
  if (!contentType) return ".bin";
  const t = contentType.toLowerCase();
  if (t.indexOf("png") >= 0) return ".png";
  if (t.indexOf("jpeg") >= 0 || t.indexOf("jpg") >= 0) return ".jpg";
  if (t.indexOf("webp") >= 0) return ".webp";
  if (t.indexOf("gif") >= 0) return ".gif";
  if (t.indexOf("mp4") >= 0) return ".mp4";
  if (t.indexOf("quicktime") >= 0) return ".mov";
  if (t.indexOf("webm") >= 0) return ".webm";
  return ".bin";
}

/** 下载单个 URL（内部处理跳转） */
function fetchOnce(
  url: string,
  destPath: string,
  timeoutMs: number,
  redirectsLeft: number,
): Promise<DownloadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: DownloadResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let mod: any;
    try {
      mod = url.indexOf("http://") === 0 ? http : https;
    } catch {
      done({ ok: false, error: "Node 网络模块不可用" });
      return;
    }

    const req = mod.get(url, (res: any) => {
      const status = res.statusCode || 0;

      // 跳转
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          done({ ok: false, error: "重定向次数过多" });
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        fetchOnce(next, destPath, timeoutMs, redirectsLeft - 1).then(done);
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        done({ ok: false, error: `下载失败（HTTP ${status}）` });
        return;
      }

      const contentType: string | undefined = res.headers["content-type"];
      let bytes = 0;
      const out = fs.createWriteStream(destPath);
      res.on("data", (chunk: any) => {
        bytes += chunk.length;
      });
      res.pipe(out);
      out.on("error", (e: any) => {
        done({ ok: false, error: String(e?.message || e) });
      });
      out.on("finish", () => {
        done({
          ok: true,
          path: destPath,
          bytes,
          contentType,
        });
      });
    });

    req.on("error", (e: any) => {
      done({ ok: false, error: String(e?.message || e) });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, error: "下载超时" });
    });
  });
}

/**
 * 把远程文件下载到本地。
 *
 * @param url 远程地址（http/https）
 * @param destPath 目标绝对路径（目录需已存在）
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts?: DownloadOptions,
): Promise<DownloadResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "无效的下载地址" };
  }
  try {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
  const res = await fetchOnce(
    url,
    destPath,
    opts?.timeoutMs ?? 180000,
    MAX_REDIRECTS,
  );
  if (res.ok && res.path) {
    const renamed = renameByContentType(res.path, res.contentType);
    if (renamed) res.path = renamed;
  }
  return res;
}

/**
 * 按真实 content type 修正文件后缀。
 *
 * 可灵的图片直链（p4-fdl.klingai.com 等）常常**不带后缀**，
 * 按 URL 猜出来的名字只能靠 contentType 兜底；而实际返回的格式
 * 未必与猜的一致（猜 .png 实际给 .jpg）—— Premiere 认后缀，
 * 后缀错了会导入失败。
 *
 * 修正失败不影响下载结果（返回原路径）。
 */
function renameByContentType(
  filePath: string,
  contentType?: string,
): string | undefined {
  if (!contentType) return undefined;
  const want = extOfContentType(contentType);
  if (want === ".bin") return undefined;
  const cur = path.extname(filePath).toLowerCase();
  if (cur === want) return undefined;
  try {
    const target = filePath.slice(0, filePath.length - cur.length) + want;
    if (fs.existsSync(target)) return undefined;
    fs.renameSync(filePath, target);
    return target;
  } catch (e) {
    console.warn("[download] 按 content-type 修正后缀失败:", filePath, e);
    return undefined;
  }
}
