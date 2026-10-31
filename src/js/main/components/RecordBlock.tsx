import { useEffect, useRef, useState } from "react";
import { registerMedia } from "../../core/api";
import type { GenerationRecord } from "../../../shared/types";
import { useVideoThumb } from "../thumb";
import { statusOf } from "../status";

/** 生成中记录的耗时文案 */
function elapsedOf(rec: GenerationRecord): string {
  if (rec.status !== "generating" || !rec.submittedAt) return "";
  const sec = Math.floor(
    (Date.now() - new Date(rec.submittedAt).getTime()) / 1000,
  );
  if (sec < 0) return "";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/**
 * 信息流里的一条记录。
 *
 * 三行结构（与 RocX RecordFeedBlock 一致）：
 *   行1  meta 摘要（模型 · 比例 · 时长 · 分辨率 · 提示词 · 状态）
 *   行2  强制 16:9 预览容器（视频居中 contain；生成中/失败时用卡片占位）
 *   行3  操作行（导入到工程 / 填入生成器 / 用作参考 / 删除）
 *
 * 图片记录（kind === "image"）走 <img> 预览，没有播放按钮，
 * meta 行把「时长」换成「张数」。
 */
export const RecordBlock = ({
  rec,
  onImport,
  onFill,
  onUseAsReference,
  onDelete,
  onRetry,
}: {
  rec: GenerationRecord;
  onImport: (rec: GenerationRecord) => void;
  onFill: (rec: GenerationRecord) => void;
  onUseAsReference: (rec: GenerationRecord) => void;
  onDelete: (rec: GenerationRecord) => void;
  onRetry: (rec: GenerationRecord) => void;
}) => {
  const isImage = rec.kind === "image";
  const [videoUrl, setVideoUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const st = statusOf(rec);
  // 图片记录不抽视频帧（useVideoThumb 对图片 URL 无意义）
  const thumb = useVideoThumb(isImage ? "" : videoUrl);
  // 一次生成多张时（workFiles）实际拿到的文件数 —— 比 params.count 更准
  const fileCount = rec.workFiles?.length || (rec.workFile ? 1 : 0);

  // 本地结果文件注册成 http 流地址，供 <video> / <img> 预览
  useEffect(() => {
    let cancelled = false;
    if (!rec.workFile) {
      setVideoUrl("");
      return;
    }
    void registerMedia(rec.workFile).then((u) => {
      if (!cancelled) setVideoUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [rec.workFile]);

  // 生成中的记录要显示耗时 → 每秒刷新一次
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (rec.status !== "generating") return;
    const timer = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [rec.status]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const showVideo = !!videoUrl && !isImage;
  const showImage = !!videoUrl && isImage;
  const canImport =
    !!rec.workFile && ["generated", "imported", "failed"].includes(rec.status);

  return (
    <article className="record-block">
      {/* 行1：参数摘要 + 提示词 + 状态 */}
      <header className="meta-line">
        <span className="meta-model">{rec.params.model}</span>
        <span className="meta-sep">·</span>
        <span className="meta-param">{rec.params.ratio}</span>
        <span className="meta-sep">·</span>
        {isImage ? (
          <span className="meta-param">
            {fileCount || rec.params.count || 1}张
          </span>
        ) : (
          <span className="meta-param">{rec.params.duration}s</span>
        )}
        <span className="meta-sep">·</span>
        <span className="meta-param">{rec.params.resolution}</span>
        <span className="meta-sep">·</span>
        <span className="prompt-inline" title={rec.prompt}>
          {rec.prompt}
        </span>
        <span className="meta-spacer" />
        <span className="status-dot" style={{ background: st.color }} />
        <span className="status-label">{st.label}</span>
        {rec.status === "failed" && (
          <button className="header-btn" onClick={() => onRetry(rec)}>
            ↻ 重试
          </button>
        )}
      </header>

      {/* 行2：16:9 预览容器 */}
      <div className="preview-frame">
        {showVideo && (
          <video
            ref={videoRef}
            src={videoUrl}
            className="frame-video"
            preload="metadata"
            muted
            playsInline
            onClick={togglePlay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        )}

        {/* 图片结果：直接铺满容器（contain，避免裁切构图） */}
        {showImage && (
          <img src={videoUrl} className="frame-image" alt={rec.prompt} />
        )}

        {/* 视频还没解出首帧时用 canvas 缩略图顶上 */}
        {!showVideo && !showImage && thumb && (
          <img src={thumb} className="frame-image" alt="" draggable={false} />
        )}

        {/* 生成中卡片 */}
        {!showVideo && !showImage && rec.status === "generating" && (
          <div className="state-card generating-card">
            <div className="generating-bar">
              <div className="generating-bar-fill" />
            </div>
            <div className="state-title">
              ⏳ 生成中{elapsedOf(rec) ? ` · ${elapsedOf(rec)}` : ""}
            </div>
            <div className="state-msg">{rec.prompt}</div>
            {rec.taskId && <div className="state-req">task_id: {rec.taskId}</div>}
          </div>
        )}

        {/* 失败卡片 */}
        {!showVideo && !showImage && rec.status === "failed" && (
          <div className="state-card failed-card">
            <div className="state-title">生成失败</div>
            <div className="state-msg">
              {rec.error?.message || "未知错误"}
            </div>
            {rec.error?.errorType && (
              <div className="state-type">{rec.error.errorType}</div>
            )}
          </div>
        )}

        {/* 空占位（排队中 / 准备素材） */}
        {!showVideo && !showImage && !thumb && rec.status === "pending" && (
          <div className="frame-placeholder">
            <span className="frame-placeholder-icon">⏳</span>
          </div>
        )}

        {/* 中心播放按钮 */}
        {showVideo && !playing && (
          <div className="play-overlay" onClick={togglePlay}>
            <svg viewBox="0 0 80 80" width="64" height="64">
              <circle
                cx="40"
                cy="40"
                r="36"
                fill="rgba(0,0,0,0.55)"
                stroke="rgba(255,255,255,0.6)"
                strokeWidth="2"
              />
              <polygon points="32,24 32,56 60,40" fill="#fff" />
            </svg>
          </div>
        )}
      </div>

      {/* 行3：操作行 */}
      <div className="action-row">
        <button
          className="action-btn primary"
          disabled={!canImport}
          onClick={() => onImport(rec)}
          title="导入到 Premiere 项目面板（不插入时间线）"
        >
          导入到工程
        </button>
        <button
          className="action-btn"
          onClick={() => onFill(rec)}
          title="把这条记录的提示词 / 参数填回生成器"
        >
          ↻ 填入生成器
        </button>
        <span className="action-spacer" />
        {rec.status === "generated" || rec.status === "imported" ? (
          <button
            className="action-btn reference-btn"
            onClick={() => onUseAsReference(rec)}
            title="把这条记录作为参考素材加回生成器"
          >
            用作参考
          </button>
        ) : null}
        <button
          className="action-btn danger"
          onClick={() => onDelete(rec)}
          title="删除这条记录"
        >
          删除
        </button>
      </div>
    </article>
  );
};
