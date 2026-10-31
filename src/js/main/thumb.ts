/**
 * 视频缩略图（Panel 层）
 *
 * 与 RocX（UXP 版）useRecordPreview 同思路：用离屏 <video> 抽一帧画到 canvas，
 * 拿到 data URL 当缩略图。
 *
 * 为什么不用 <video> 直接当缩略图：
 *   - <video> 元素在 80px 宽的导航列里，首帧常常还没解出来（黑块）
 *   - 一列十几条记录时，每个都挂一个 <video> 会把内存吃满
 *   - canvas 抽出来的 data URL 可以缓存，滚动时不重复解码
 *
 * 抽帧失败不阻塞 UI —— 退化成占位图标。
 */
import { useEffect, useState } from "react";

/** 缩略图缓存（url → data URL），跨组件复用 */
const cache = new Map<string, string>();

/** 抽帧失败 / 正在抽的标记 */
const pending = new Map<string, boolean>();

/**
 * 从视频 URL 抽一帧做缩略图。
 *
 * @param url 视频地址（本地 HTTP 流）
 * @param at 抽帧位置（秒）；默认取靠前但非 0 的位置，避免黑场
 */
export function useVideoThumb(url: string, at = 0.1): string {
  const [thumb, setThumb] = useState(() => (url ? cache.get(url) || "" : ""));

  useEffect(() => {
    if (!url) {
      setThumb("");
      return;
    }
    const cached = cache.get(url);
    if (cached) {
      setThumb(cached);
      return;
    }
    if (pending.get(url)) return;

    pending.set(url, true);
    let cancelled = false;

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = url;

    const cleanup = () => {
      video.removeAttribute("src");
      video.load?.();
      pending.delete(url);
    };

    const grab = () => {
      try {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        if (!w || !h) {
          cleanup();
          return;
        }
        // 缩到 160px 宽足够导航列使用（data URL 体积也小）
        const targetW = 160;
        const targetH = Math.max(1, Math.round((h / w) * targetW));
        const canvas = document.createElement("canvas");
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          return;
        }
        ctx.drawImage(video, 0, 0, targetW, targetH);
        const data = canvas.toDataURL("image/jpeg", 0.7);
        cache.set(url, data);
        if (!cancelled) setThumb(data);
      } catch {
        // 抽帧失败 → 保持空缩略图
      }
      cleanup();
    };

    video.addEventListener("loadeddata", () => {
      // 定位到指定时间点；部分格式 seek 不生效，失败就用当前帧
      const seek = () => {
        try {
          video.currentTime = at;
        } catch {
          /* ignore */
        }
        grab();
      };
      if (video.readyState >= 2) seek();
      else video.addEventListener("canplay", seek, { once: true });
    });
    video.addEventListener("error", cleanup);

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [url, at]);

  return thumb;
}

/** 清空缩略图缓存（记录被删除时用） */
export function clearThumbCache(): void {
  cache.clear();
}
