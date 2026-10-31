/**
 * 抓帧 / 抓视频（Node 层）
 *
 * 抓帧：host 层的 `exportFramePNG` **不是同步的** —— 调用返回时 PNG 还没写完，
 * 所以这里轮询输出文件是否出现（并等到大小稳定）才算完成。
 *
 * 抓视频：host 层的 `exportAsMediaDirect` 是同步的（返回时文件已写完），
 * 只需校验产物存在即可。
 *
 * 产物落在工程旁的 `AI-Generated-Media/References/`，
 * 作为图生视频 / 图生图的参考素材。
 */
import { fs, path } from "../lib/cep/node";
import { exportFrame, exportSequenceClip } from "./ppro";
import { getExtensionRoot } from "./storage/paths";
import { startKlingPreUpload } from "./kling/preUpload";
import { ensureWorkDir, REFERENCES_SUBDIR } from "./storage/workDir";

/** 抓帧轮询：最多等多久（毫秒） */
const FRAME_WAIT_MS = 20000;
/** 抓帧轮询间隔（毫秒） */
const FRAME_POLL_MS = 300;

/** 打包在扩展里的导出预设（h264 匹配帧 10Mbps，源 RocX 同款） */
const EPR_NAME = "h264-match-10mbps.epr";

export interface CaptureFrameResult {
  ok: boolean;
  error?: string;
  /** 输出 PNG 绝对路径 */
  path?: string;
  /** 文件名（记录里显示用） */
  fileName?: string;
  /** 文件大小（字节） */
  sizeBytes?: number;
  /** 实际导出的帧号 */
  frameNumber?: number;
  /** 序列画幅宽（面板用于「首次抓帧自动填画幅比」） */
  width?: number;
  /** 序列画幅高 */
  height?: number;
}

/** 延迟 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 抓当前活动序列的一帧。
 *
 * @param opts.projectPath 归属工程路径（决定素材目录；空 → 落到插件数据目录）
 * @param opts.frameNumber 目标帧号；不传则取当前播放头
 * @param opts.ticks 目标时间点（ticks 字符串）；与 frameNumber 二选一
 * @param opts.seconds 目标时间点（秒）；与 frameNumber 二选一
 * @param opts.fileName 期望的文件名（不含目录、不含扩展名）
 */
export async function captureFrame(opts?: {
  projectPath?: string;
  frameNumber?: number;
  ticks?: string;
  seconds?: number;
  fileName?: string;
}): Promise<CaptureFrameResult> {
  const work = ensureWorkDir(opts?.projectPath, REFERENCES_SUBDIR);
  if (!work.ok || !work.dir) {
    return { ok: false, error: work.error || "无法创建参考素材目录" };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rawName = opts?.fileName || `frame_${stamp}`;
  // 去掉调用方可能带上的扩展名 —— Premiere 会自己补 .png
  const baseName = rawName.replace(/\.png$/i, "");

  // 查重：按「最终文件名」（base + .png）判断是否已存在
  let base = baseName;
  for (let i = 1; i <= 999; i++) {
    const png = path.join(work.dir, `${base}.png`);
    const raw = path.join(work.dir, base);
    if (!fs.existsSync(png) && !fs.existsSync(raw)) break;
    base = `${baseName}_${i}`;
  }
  /** 传给 host 的路径不带扩展名 —— Premiere 会自己补 .png */
  const destNoExt = path.join(work.dir, base);

  const res = await exportFrame({
    frameNumber: opts?.frameNumber,
    ticks: opts?.ticks,
    seconds: opts?.seconds,
    outputPath: destNoExt,
  });
  if (!res.ok) {
    return { ok: false, error: res.error || "抓帧失败" };
  }

  // 候选落地路径：优先「补了 .png 的」，兜底「原样落地的」
  const candidates = [destNoExt + ".png", destNoExt];

  // 轮询等待 PNG 落地（大小稳定即认为写完）
  const deadline = Date.now() + FRAME_WAIT_MS;
  const sizes = new Map<string, number>();
  for (;;) {
    for (const candidate of candidates) {
      let size = -1;
      try {
        if (fs.existsSync(candidate)) size = fs.statSync(candidate).size;
      } catch {
        size = -1;
      }
      const prev = sizes.get(candidate);
      if (size > 0 && size === prev) {
        warmUpReference(candidate);
        return {
          ok: true,
          path: candidate,
          fileName: path.basename(candidate),
          sizeBytes: size,
          frameNumber: res.frameNumber,
          width: res.width,
          height: res.height,
        };
      }
      sizes.set(candidate, size);
    }
    if (Date.now() >= deadline) break;
    await delay(FRAME_POLL_MS);
  }
  return { ok: false, error: "抓帧超时（PNG 未生成）" };
}

export interface CaptureClipResult {
  ok: boolean;
  error?: string;
  /** 输出 MP4 绝对路径 */
  path?: string;
  /** 文件名（记录里显示用） */
  fileName?: string;
  /** 文件大小（字节） */
  sizeBytes?: number;
  /** 入出点片段时长（秒） */
  durationSeconds?: number;
  /** 序列画幅宽（面板用于「首次抓视频自动填画幅比」） */
  width?: number;
  /** 序列画幅高 */
  height?: number;
}

/**
 * host 层错误码 → 中文文案。
 *
 * host 层（ExtendScript）回传的字符串按系统代码页解码，中文会乱码，
 * 所以 host 只回 ASCII 错误码，文案在这里出。
 */
function mapClipError(err?: string): string {
  if (!err) return "抓视频失败";
  if (err === "no_io_points") {
    return "请先在时间轴上设置入出点（I / O 键）再抓视频";
  }
  if (err === "no_project") return "没有打开的工程";
  if (err === "no_sequence") return "当前没有活动序列";
  if (err === "io_read_failed") return "无法读取序列入出点";
  if (err === "missing_args") return "缺少输出路径或导出预设";
  if (err.startsWith("missing_preset:")) {
    return "导出预设缺失：" + err.slice("missing_preset:".length);
  }
  if (err.startsWith("export_failed:")) {
    return "导出失败（exportAsMediaDirect: " + err.slice("export_failed:".length) + "）";
  }
  return err;
}

/**
 * 抓视频：把当前序列入出点（I/O）之间的片段导出为 MP4 参考视频。
 *
 * 走 Premiere 内置导出管线（`exportAsMediaDirect` + .epr 预设），
 * **不依赖 AME**。host 端同步导出，返回时文件已写完。
 *
 * @param opts.projectPath 归属工程路径（决定素材目录；空 → 落到插件数据目录）
 */
export async function captureClip(opts?: {
  projectPath?: string;
}): Promise<CaptureClipResult> {
  const work = ensureWorkDir(opts?.projectPath, REFERENCES_SUBDIR);
  if (!work.ok || !work.dir) {
    return { ok: false, error: work.error || "无法创建参考素材目录" };
  }

  // 导出预设：随扩展打包（public/epr/ → dist/cep/epr/）
  const root = getExtensionRoot();
  if (!root) {
    return { ok: false, error: "无法定位扩展目录（导出预设不可用）" };
  }
  const eprPath = path.join(root, "epr", EPR_NAME);
  if (!fs.existsSync(eprPath)) {
    return { ok: false, error: "导出预设缺失：" + eprPath };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `clip_${stamp}`;
  let base = baseName;
  for (let i = 1; i <= 999; i++) {
    if (!fs.existsSync(path.join(work.dir, `${base}.mp4`))) break;
    base = `${baseName}_${i}`;
  }
  const dest = path.join(work.dir, `${base}.mp4`);

  const res = await exportSequenceClip({
    outputPath: dest,
    eprPath,
  });
  if (!res.ok) {
    return { ok: false, error: mapClipError(res.error) };
  }

  // host 返回时文件应已写完；校验一次并拿大小
  let size = 0;
  try {
    size = fs.existsSync(res.path || dest)
      ? fs.statSync(res.path || dest).size
      : 0;
  } catch {
    size = 0;
  }
  if (!size) {
    return { ok: false, error: "导出已完成，但产物文件不存在" };
  }

  return {
    ok: true,
    path: res.path || dest,
    fileName: path.basename(res.path || dest),
    sizeBytes: size,
    durationSeconds: res.durationSeconds,
    width: res.width,
    height: res.height,
  };
}

/**
 * 抓帧成功后启动素材预上传（后台）。
 *
 * 预上传把素材换成可灵 CDN 直链，提交时 CLI 直接用直链（不再现传 4-8s）。
 * 用户从抓帧到写完提示词通常有几十秒，正好覆盖上传耗时。
 */
export function warmUpReference(localPath: string): void {
  try {
    startKlingPreUpload({ localPath });
  } catch (e) {
    console.warn("[capture] 预上传启动失败:", e);
  }
}
