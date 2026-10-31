/**
 * 生成器状态（Panel 层）
 *
 * 为什么要独立成 store：
 *   RocX 里「↻ 填入生成器」把某条记录的 prompt / 参数 / 参考素材回填到输入区，
 *   而输入区在**浮动 prompt bar**、记录在**信息流**里 —— 两个相隔很远的组件
 *   要共享同一份表单状态。UXP 靠 inject/provide，React 里用 hook + props。
 *
 * 本 store 只管「用户正在编辑什么」，不碰任何 I/O。
 */
import { useCallback, useMemo, useState } from "react";
import type { GenerationRecord, KlingReferenceType } from "../../shared/types";

/** 生成器里的一条参考素材 */
export interface GenRef {
  type: KlingReferenceType;
  /** 本地绝对路径 */
  localPath: string;
  /** 缩略图（data URL） */
  thumb: string;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** 参考视频时长（秒；抓视频时已知，webhook 生成时长用） */
  durationSeconds?: number;
  /** 正在 Photoshop 中编辑（抓帧→PS 流程；点「修改完成」后清除） */
  editingInPs?: boolean;
}

/** 生成模式：视频 / 图片 */
export type GenMode = "video" | "image";

/** 视频侧参数（provider + 模型 + 画幅 + 时长 + 分辨率） */
export interface VideoParams {
  /** 提交通道："kling"（CLI）| "minimax" 等（HTTP provider） */
  provider: string;
  model: string;
  ratio: string;
  duration: string;
  resolution: string;
}

/** 图片侧参数（provider + 模型 + 画幅 + img_resolution + 张数） */
export interface ImageParams {
  provider: string;
  model: string;
  ratio: string;
  /** img_resolution 档位："1k" / "2k" / "4k" */
  resolution: string;
  /** 张数 */
  count: string;
}

/** 生成器表单状态 */
export interface GenState {
  /** 当前模式 */
  mode: GenMode;
  prompt: string;
  refs: GenRef[];
  /** 视频参数（mode === "video" 时生效） */
  video: VideoParams;
  /** 图片参数（mode === "image" 时生效） */
  image: ImageParams;
}

/** 初始状态 */
export const EMPTY_GEN_STATE: GenState = {
  mode: "video",
  prompt: "",
  refs: [],
  video: { provider: "kling", model: "", ratio: "", duration: "", resolution: "" },
  image: { provider: "kling", model: "", ratio: "", resolution: "", count: "" },
};

/** 生成器表单的读写接口 */
export interface GenStore extends GenState {
  /** 局部更新 */
  patch: (p: Partial<GenState>) => void;
  /**
   * 局部更新（函数式）。
   *
   * 需要函数式是因为「换模型后收敛参数」这类逻辑要基于**最新**状态判断，
   * 而 effect 闭包里的 `gen` 可能是上一帧的值。
   */
  patchFn: (fn: (prev: GenState) => Partial<GenState>) => void;
  /** 更新当前模式的参数桶 */
  patchParams: (p: Partial<VideoParams & ImageParams>) => void;
  /** 替换全部（切工程 / 切模型时用） */
  replace: (s: GenState) => void;
  /** 追加一条参考素材 */
  addRef: (ref: GenRef) => void;
  /** 按 localPath 移除参考素材 */
  removeRef: (localPath: string) => void;
  /** 更新一条参考素材（PS 编辑状态流转 / 缩略图刷新用） */
  patchRef: (localPath: string, patch: Partial<GenRef>) => void;
  /** 用一条记录回填整个表单（RocX 的「↻ 填入生成器」） */
  fillFromRecord: (rec: GenerationRecord, thumbOf?: (p: string) => string) => void;
  /** 是否有未提交的内容 */
  dirty: boolean;
}

/**
 * 生成器表单 hook。
 *
 * `fillFromRecord` 刻意**不自动提交** —— 用户回填后能先看一遍 prompt
 * 再点生成（RocX 同款行为）。
 */
export function useGenStore(): GenStore {
  const [state, setState] = useState<GenState>(EMPTY_GEN_STATE);

  const patch = useCallback((p: Partial<GenState>) => {
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const patchFn = useCallback((fn: (prev: GenState) => Partial<GenState>) => {
    setState((prev) => ({ ...prev, ...fn(prev) }));
  }, []);

  // 参数桶按当前模式路由 —— 视频参数与图片参数的值域不通用，不能混
  const patchParams = useCallback(
    (p: Partial<VideoParams & ImageParams>) => {
      setState((prev) =>
        prev.mode === "image"
          ? { ...prev, image: { ...prev.image, ...p } }
          : { ...prev, video: { ...prev.video, ...p } },
      );
    },
    [],
  );

  const replace = useCallback((s: GenState) => setState(s), []);

  const addRef = useCallback((ref: GenRef) => {
    setState((prev) =>
      prev.refs.some((r) => r.localPath === ref.localPath)
        ? prev
        : { ...prev, refs: [...prev.refs, ref] },
    );
  }, []);

  const removeRef = useCallback((localPath: string) => {
    setState((prev) => ({
      ...prev,
      refs: prev.refs.filter((r) => r.localPath !== localPath),
    }));
  }, []);

  const patchRef = useCallback(
    (localPath: string, patch: Partial<GenRef>) => {
      setState((prev) => ({
        ...prev,
        refs: prev.refs.map((r) =>
          r.localPath === localPath ? { ...r, ...patch } : r,
        ),
      }));
    },
    [],
  );

  const fillFromRecord = useCallback(
    (rec: GenerationRecord, thumbOf?: (p: string) => string) => {
      const isImage = rec.kind === "image";
      const refs = (rec.references || []).map((r) => ({
        type: r.type,
        localPath: r.localPath,
        thumb: thumbOf ? thumbOf(r.localPath) : "",
        fileName: r.fileName,
        sizeBytes: r.sizeBytes,
        durationSeconds: r.durationSeconds,
      }));
      setState((prev) =>
        isImage
          ? {
              ...prev,
              mode: "image",
              prompt: rec.prompt,
              refs,
              image: {
                provider: rec.params.provider || "kling",
                model: rec.params.model,
                ratio: rec.params.ratio,
                resolution: rec.params.resolution,
                count: String(rec.params.count || 1),
              },
            }
          : {
              ...prev,
              mode: "video",
              prompt: rec.prompt,
              refs,
              video: {
                provider: rec.params.provider || "kling",
                model: rec.params.model,
                ratio: rec.params.ratio,
                duration: String(rec.params.duration),
                resolution: rec.params.resolution,
              },
            },
      );
    },
    [],
  );

  const dirty = useMemo(
    () =>
      !!state.prompt.trim() ||
      state.refs.length > 0 ||
      state.video.model !== "" ||
      state.image.model !== "",
    [state.prompt, state.refs.length, state.video.model, state.image.model],
  );

  return {
    ...state,
    patch,
    patchFn,
    patchParams,
    replace,
    addRef,
    removeRef,
    patchRef,
    fillFromRecord,
    dirty,
  };
}
