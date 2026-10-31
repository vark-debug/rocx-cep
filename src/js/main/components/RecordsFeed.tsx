import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getRecords,
  importRecordToProject,
  registerMedia,
  removeRecord,
  retryGeneration,
  subscribeGeneration,
} from "../../core/api";
import type { GenerationRecord } from "../../../shared/types";
import { RecordBlock } from "./RecordBlock";
import { statusOf } from "../status";
import { useVideoThumb } from "../thumb";

/** 左侧导航列里的一条缩略图 */
const ThumbItem = ({
  rec,
  active,
  onClick,
  innerRef,
}: {
  rec: GenerationRecord;
  active: boolean;
  onClick: () => void;
  innerRef: (el: HTMLDivElement | null) => void;
}) => {
  const [mediaUrl, setMediaUrl] = useState("");
  const st = statusOf(rec);
  const isImage = rec.kind === "image";

  useEffect(() => {
    let cancelled = false;
    if (!rec.workFile) return;
    void registerMedia(rec.workFile).then((u) => {
      if (!cancelled) setMediaUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [rec.workFile]);

  // 图片记录直接铺图（不抽视频帧）
  const thumb = useVideoThumb(isImage ? "" : mediaUrl);

  return (
    <div
      className={`thumb-item${active ? " active" : ""}`}
      onClick={onClick}
      title={rec.prompt.slice(0, 60)}
      ref={innerRef}
    >
      {isImage && mediaUrl ? (
        <img src={mediaUrl} className="thumb-image" alt="" draggable={false} />
      ) : thumb ? (
        <img src={thumb} className="thumb-image" alt="" draggable={false} />
      ) : mediaUrl ? (
        <video
          src={mediaUrl}
          className="thumb-video"
          muted
          preload="metadata"
        />
      ) : (
        <div className="thumb-placeholder">
          <span className="thumb-placeholder-icon">
            {rec.status === "failed" ? "⚠" : isImage ? "🖼" : "🎬"}
          </span>
        </div>
      )}
      <div className="thumb-status" style={{ background: st.color }} />
    </div>
  );
};

/**
 * 生成记录区：左列缩略图导航 + 右列信息流。
 *
 * 与 RocX（UXP 版）RecordsPanel 同结构：
 *   - 点缩略图 → 信息流平滑滚到对应块
 *   - 滚动信息流 → 高亮当前可视比例最大的块对应的缩略图
 */
export const RecordsFeed = ({
  onFill,
  onUseAsReference,
}: {
  onFill: (rec: GenerationRecord) => void;
  onUseAsReference: (rec: GenerationRecord) => void;
}) => {
  const records = useSyncExternalStore(subscribeGeneration, getRecords);
  const [activeId, setActiveId] = useState("");
  const [message, setMessage] = useState("");
  const feedEl = useRef<HTMLDivElement | null>(null);
  const thumbColEl = useRef<HTMLDivElement | null>(null);
  const blockEls = useRef(new Map<string, HTMLElement>());
  const thumbEls = useRef(new Map<string, HTMLElement>());
  const visibleRatios = useRef(new Map<string, number>());

  // 记录变化时重置高亮（新的第一条在最上面）
  useEffect(() => {
    if (records.length && !records.some((r) => r.id === activeId)) {
      setActiveId(records[0].id);
    }
  }, [records, activeId]);

  const registerBlock = useCallback((id: string, el: unknown) => {
    const map = blockEls.current;
    if (el) {
      map.set(id, el as HTMLElement);
    } else {
      map.delete(id);
      visibleRatios.current.delete(id);
    }
  }, []);

  const registerThumb = useCallback((id: string, el: unknown) => {
    if (el) {
      thumbEls.current.set(id, el as HTMLElement);
    } else {
      thumbEls.current.delete(id);
    }
  }, []);

  // 高亮项跑出左列可视区时把它滚回来 —— 否则右列往下滚，
  // 左列高亮就消失，用户以为左列「不跟随」
  useEffect(() => {
    const col = thumbColEl.current;
    const el = activeId ? thumbEls.current.get(activeId) : undefined;
    if (!col || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = col.scrollTop;
    const viewBottom = viewTop + col.clientHeight;
    if (top < viewTop) {
      col.scrollTop = Math.max(0, top - 4);
    } else if (bottom > viewBottom) {
      col.scrollTop = bottom - col.clientHeight + 4;
    }
  }, [activeId, records]);

  // 高亮反向同步：取可视比例最大的块
  useEffect(() => {
    const feed = feedEl.current;
    if (!feed || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.recId || "";
          if (e.isIntersecting) {
            visibleRatios.current.set(id, e.intersectionRatio);
          } else {
            visibleRatios.current.delete(id);
          }
        }
        let bestId = "";
        let best = 0;
        visibleRatios.current.forEach((ratio, id) => {
          if (ratio > best) {
            best = ratio;
            bestId = id;
          }
        });
        if (bestId) setActiveId(bestId);
      },
      { root: feed, threshold: [0, 0.2, 0.5, 0.8] },
    );

    blockEls.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [records]);

  const jumpTo = (rec: GenerationRecord) => {
    setActiveId(rec.id);
    const el = blockEls.current.get(rec.id);
    const scroller = feedEl.current;
    if (el && scroller) {
      scroller.scrollTo({
        top: Math.max(0, el.offsetTop - 4),
        behavior: "smooth",
      });
    }
  };

  const onImport = async (rec: GenerationRecord) => {
    setMessage("");
    const res = await importRecordToProject(rec.id);
    if (!res.ok) setMessage(res.error || "导入失败");
  };

  const onDelete = (rec: GenerationRecord) => {
    setMessage("");
    void removeRecord(rec.id);
  };

  const onRetry = async (rec: GenerationRecord) => {
    setMessage("");
    try {
      await retryGeneration(rec.id);
    } catch (e: any) {
      setMessage(String(e?.message || e));
    }
  };

  if (!records.length) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-title">还没有生成记录</div>
        <div className="feed-empty-hint">
          在下方输入提示词点「生成」，或先「抓帧」把当前播放头画面作为参考素材。
        </div>
      </div>
    );
  }

  return (
    <section className="records-panel">
      {/* 左列：缩略图导航 */}
      <div className="thumb-column" ref={thumbColEl}>
        {records.map((rec) => (
          <ThumbItem
            key={rec.id}
            rec={rec}
            active={rec.id === activeId}
            onClick={() => jumpTo(rec)}
            innerRef={(el) => registerThumb(rec.id, el)}
          />
        ))}
      </div>

      {/* 右列：信息流 */}
      <div className="feed-column" ref={feedEl}>
        {records.map((rec) => (
          <div
            key={rec.id}
            ref={(el) => registerBlock(rec.id, el)}
            data-rec-id={rec.id}
          >
            <RecordBlock
              rec={rec}
              onImport={onImport}
              onFill={onFill}
              onUseAsReference={onUseAsReference}
              onDelete={onDelete}
              onRetry={onRetry}
            />
          </div>
        ))}
        {message && <div className="form-message">{message}</div>}
      </div>
    </section>
  );
};
