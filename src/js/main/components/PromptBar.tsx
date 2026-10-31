import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  captureClip,
  captureFrame,
  checkKlingReady,
  getApiKey,
  getKlingDefaultModel,
  getKlingEnv,
  getKlingImageDefaultModel,
  getKlingImageModels,
  getKlingModels,
  getProjectInfo,
  getSequenceInfoSnapshot,
  imageProviderOptions,
  invalidateKlingUpload,
  isDryRun,
  listProviderImageModels,
  listProviderModels,
  openInPhotoshop,
  readImageDataUrl,
  submitGeneration,
  submitImageGeneration,
  subscribeGeneration,
  subscribeKlingState,
  videoProviderOptions,
  warmUpReference,
} from "../../core/api";
import type { GenMode, GenStore } from "../store";
import {
  filterTemplates,
  matchTemplateGate,
  resolveTemplate,
  type PromptTemplate,
} from "../promptTemplates";

/**
 * 浮动 prompt bar（贴底覆盖）
 *
 * 结构与 RocX（UXP 版）一致：
 *   工具行：模式 tab（左）+ 抓素材按钮（右）
 *   参考素材列表
 *   提示词输入框
 *   参数行：模型按钮 + 参数按钮 + 生成按钮
 *
 * 两种模式的参数域完全不同（实测 2026-10 的可灵 who_am_i 声明）：
 *   视频 → 模型 / 画幅 / 时长 / 分辨率("1080p")
 *   图片 → 模型 / 画幅 / img_resolution("1k") / 张数（无时长）
 */
export const PromptBar = ({ gen }: { gen: GenStore }) => {
  const videoModels = useSyncExternalStore(subscribeKlingState, getKlingModels);
  const imageModels = useSyncExternalStore(subscribeKlingState, getKlingImageModels);
  const env = useSyncExternalStore(subscribeKlingState, getKlingEnv);
  const project = useSyncExternalStore(subscribeGeneration, getProjectInfo);
  const seq = useSyncExternalStore(subscribeGeneration, getSequenceInfoSnapshot);

  const [busy, setBusy] = useState(false);
  /**
   * 瞬时提示卡片：出现 3 秒 → 1 秒渐隐 → 卸载。
   * 原先的常驻 .form-message 会把提示和底部 hint 挤在一起，改成浮层卡片。
   */
  const [toast, setToast] = useState<{
    text: string;
    leaving: boolean;
  } | null>(null);
  const toastTimers = useRef<number[]>([]);

  const showToast = (text: string) => {
    for (const id of toastTimers.current) window.clearTimeout(id);
    toastTimers.current = [];
    setToast({ text, leaving: false });
    toastTimers.current = [
      window.setTimeout(() => {
        setToast((t) => (t ? { ...t, leaving: true } : t));
      }, 3000),
      window.setTimeout(() => setToast(null), 4000),
    ];
  };

  const hideToast = () => {
    for (const id of toastTimers.current) window.clearTimeout(id);
    toastTimers.current = [];
    setToast(null);
  };

  // 卸载时清掉定时器，避免面板复用时旧定时器改动新状态的 toast
  useEffect(
    () => () => {
      for (const id of toastTimers.current) window.clearTimeout(id);
    },
    [],
  );
  const [modelOpen, setModelOpen] = useState(false);
  const [paramOpen, setParamOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const isImage = gen.mode === "image";

  // ---- provider（提交通道）：kling 走 CLI；其余走 HTTP provider（需 API Key）----
  const providerOptions = useMemo(
    () => (isImage ? imageProviderOptions() : videoProviderOptions()),
    [isImage],
  );
  const curProvider = isImage ? gen.image.provider : gen.video.provider;

  /**
   * 统一模型视图：kling（CLI，who_am_i 动态清单）与 HTTP provider（静态清单）
   * 的描述符字段不同，归一成 UI 消费的形状。
   */
  const curProviderModels = useMemo<UiModel[]>(() => {
    if (curProvider === "kling") {
      return isImage
        ? imageModels.map((m) => ({
            modelId: m.modelId,
            displayName: m.displayName,
            ratios: m.ratios,
            durations: [],
            resolutions: m.resolutions,
            counts: m.counts,
            defaultResolution: m.defaultResolution,
            defaultRatio: m.defaultRatio,
            imageInput: m.imageInput,
          }))
        : videoModels.map((m) => ({
            modelId: m.modelId,
            displayName: m.displayName,
            ratios: m.ratios,
            durations: m.durations,
            resolutions: m.resolutions,
            counts: [],
            imageInput: m.imageInput,
          }));
    }
    const raw = isImage
      ? listProviderImageModels(curProvider)
      : listProviderModels(curProvider);
    return raw.map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      ratios: m.paramConstraints.ratios,
      durations: m.paramConstraints.durations,
      resolutions: m.paramConstraints.resolutions,
      // 图片 provider 单次出 1 张（RunningHub 工作流固定 1 张）
      counts: isImage ? ["1"] : [],
      imageInput: m.capabilities.some(
        (c) =>
          c === "imageReference" ||
          c === "videoReference" ||
          c === "audioReference",
      ),
    }));
  }, [curProvider, isImage, videoModels, imageModels]);

  const current =
    curProviderModels.find(
      (m) => m.modelId === (isImage ? gen.image.model : gen.video.model),
    ) || curProviderModels[0];

  // 模型清单到达 / 切 provider / 换模型后：选定默认模型 + 参数收敛到该模型值域
  useEffect(() => {
    if (!current) return;
    gen.patchFn((prev) => {
      if (isImage) {
        const p = prev.image;
        if (p.provider !== curProvider) return {}; // provider 已再次切换，放弃本次收敛
        const def = curProvider === "kling" ? getKlingImageDefaultModel() : "";
        return {
          image: {
            ...p,
            model: convergeModel(p.model, curProviderModels, def),
            ratio: current.ratios.includes(p.ratio)
              ? p.ratio
              : current.defaultRatio || current.ratios[0] || "",
            resolution: current.resolutions.includes(p.resolution)
              ? p.resolution
              : current.defaultResolution || current.resolutions[0] || "",
            count: current.counts.includes(p.count)
              ? p.count
              : current.counts[0] || "1",
          },
        };
      }
      const p = prev.video;
      if (p.provider !== curProvider) return {};
      const def = curProvider === "kling" ? getKlingDefaultModel() : "";
      return {
        video: {
          ...p,
          model: convergeModel(p.model, curProviderModels, def),
          ratio: current.ratios.includes(p.ratio)
            ? p.ratio
            : current.ratios[0] || "",
          duration: current.durations.includes(Number(p.duration))
            ? p.duration
            : String(current.durations[0] ?? ""),
          resolution: current.resolutions.includes(p.resolution)
            ? p.resolution
            : current.resolutions[0] || "",
        },
      };
    });
    // current / curProviderModels 引用由 useMemo 保持稳定，仅在清单或 provider 变化时触发
  }, [current, curProviderModels, curProvider, isImage]);

  // ---- 快捷模板（输入 "/" 唤起，自 UXP 版移植）----
  const [tplOpen, setTplOpen] = useState(false);
  const [tplQuery, setTplQuery] = useState("");
  const [tplActive, setTplActive] = useState(0);
  const tplTriggerStart = useRef(0);
  const tplMode = isImage ? "image" : "video";
  const tplFiltered = filterTemplates(tplMode, tplQuery);

  /**
   * 智能填画幅比：素材宽高比 → 与当前模型合法 ratio 档匹配最近档（UXP 同款）。
   * 抓帧 / 抓视频两条路径共享；无匹配档或已在当前档时不写。
   */
  const applySmartRatio = (width: number, height: number) => {
    const actual = ratioStringFromSize(width, height);
    if (!actual) return;
    const closest = pickClosestRatio(actual, current?.ratios);
    if (closest && curParams(gen).ratio !== closest) {
      console.log(`[autofill] ratio=${closest} (from ${width}x${height})`);
      gen.patchParams({ ratio: closest });
    }
  };

  /**
   * 智能填生成时长：入出点时长向上取整到当前模型合法档位（6.8s→7s）。
   * 超过最大档时取最大档并提示，但不阻止流程（UXP 同款）。
   */
  const fillDuration = (sec: number) => {
    const ds = [...(current?.durations ?? [])].sort((a, b) => a - b);
    if (!ds.length) return;
    const maxD = ds[ds.length - 1];
    if (sec > maxD) {
      gen.patchParams({ duration: String(maxD) });
      showToast(
        `素材时长 ${sec.toFixed(1)}s 超过当前模型最大档 ${maxD}s，生成时长已设为 ${maxD}s，流程继续`,
      );
    } else {
      const d = ds.find((x) => x >= sec) ?? maxD;
      gen.patchParams({ duration: String(d) });
    }
  };

  /**
   * 抓帧。openPs 为 true 时走「抓帧→PS」流程：
   * 素材带 editingInPs 标记（状态显示「✏ PS 中」），
   * 用户在 PS 里改完点「修改完成」确认。
   */
  const grabFrame = async (openPs?: boolean) => {
    setBusy(true);
    hideToast();
    try {
      const res = await captureFrame({ projectPath: project.projectPath });
      if (!res.ok || !res.path) {
        showToast(res.error || "抓帧失败");
        return;
      }
      // 首次抓帧（push 前没有其他图片参考）：用序列画幅自动填比例。
      // 仅视频模式生效；「抓帧→PS」路径素材还没确认，不填（UXP 同款）。
      const isFirstImageRef = gen.refs.every(
        (r) => r.type !== "reference_image",
      );
      gen.addRef({
        type: "reference_image",
        localPath: res.path,
        thumb: readImageDataUrl(res.path),
        fileName: res.fileName || res.path.split(/[\\/]/).pop() || "参考图",
        sizeBytes: res.sizeBytes || 0,
        editingInPs: openPs || undefined,
      });
      if (!openPs && !isImage && isFirstImageRef) {
        applySmartRatio(res.width || 0, res.height || 0);
      }
      if (openPs) {
        // 不 await：PS 冷启动要 20~40s，不能把 busy 挂那么久；
        // 失败时异步提示（成功静默 —— PS 窗口自己会弹出来）
        void openInPhotoshop(res.path).then((ps) => {
          if (!ps.ok) showToast(ps.error || "无法打开 Photoshop");
        });
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * 抓视频：把序列入出点（I/O）之间的片段导出为 MP4 参考视频。
   *
   * 走 Premiere 内置导出管线（不依赖 AME）。host 端是同步导出 ——
   * 片段越长本函数等待越久（Premiere 界面上显示导出进度条）。
   *
   * 首个视频参考时自动填生成时长（向上取整到合法档位）与画幅比（UXP 同款）。
   */
  const grabClip = async () => {
    setBusy(true);
    hideToast();
    try {
      const res = await captureClip({ projectPath: project.projectPath });
      if (!res.ok || !res.path) {
        showToast(res.error || "抓视频失败");
        return;
      }
      // 首个视频参考（push 前没有其他视频参考）才自动填参数
      const isFirstVideoRef = gen.refs.every(
        (r) => r.type !== "reference_video",
      );
      gen.addRef({
        type: "reference_video",
        localPath: res.path,
        thumb: "",
        fileName: res.fileName || res.path.split(/[\\/]/).pop() || "参考视频",
        sizeBytes: res.sizeBytes || 0,
        durationSeconds: res.durationSeconds,
      });
      if (isFirstVideoRef) {
        if (res.durationSeconds && res.durationSeconds > 0) {
          fillDuration(res.durationSeconds);
        }
        applySmartRatio(res.width || 0, res.height || 0);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * 「修改完成」：PS 已把文件改了 —— 旧直链指向的还是旧内容，
   * 必须失效预上传缓存重新传；缩略图也重读一次。
   */
  const confirmPsEdit = (localPath: string) => {
    invalidateKlingUpload(localPath);
    warmUpReference(localPath);
    gen.patchRef(localPath, {
      thumb: readImageDataUrl(localPath),
      editingInPs: false,
    });
  };

  /**
   * 快捷模板：输入框变化时的 "/" 触发器（自 UXP 版移植）。
   * 触发条件：输入 "/" 且其前面是开头 / 空白字符（为后续 @素材 触发保留词法空间）。
   * 弹层打开期间继续输入作为过滤词（输入空白字符或过长时关闭）。
   */
  const onPromptInput = (value: string, caret: number) => {
    gen.patch({ prompt: value });
    if (tplOpen) {
      const q = value.slice(tplTriggerStart.current + 1, caret);
      if (/\s/.test(q) || q.length > 30) {
        setTplOpen(false);
        return;
      }
      setTplQuery(q);
      setTplActive(0);
      if (!filterTemplates(tplMode, q).length) setTplOpen(false);
    } else if (
      caret >= 1 &&
      value[caret - 1] === "/" &&
      (caret === 1 || /\s/.test(value[caret - 2]))
    ) {
      setTplOpen(true);
      tplTriggerStart.current = caret - 1;
      setTplQuery("");
      setTplActive(0);
    }
  };

  /** 插入模板：替换 "/" 及过滤词为解析后的文本，光标落在 {xxx} 锚点并全选预填 */
  const insertTemplate = (t: PromptTemplate) => {
    setTplOpen(false);
    const el = promptRef.current;
    if (!el) return;
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    const resolved = resolveTemplate(t.template, tplMode);
    const next =
      v.slice(0, tplTriggerStart.current) + resolved.text + v.slice(caret);
    gen.patch({ prompt: next });
    // 受控组件：等 React 渲染出新 value 后再设光标区间
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(
        tplTriggerStart.current + resolved.cursorStart,
        tplTriggerStart.current + resolved.cursorEnd,
      );
    });
  };

  /** 模板浮层的键盘导航：↑↓ 选择、Enter/Tab 插入、Esc 关闭 */
  const onPromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!tplOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setTplActive((i) => Math.min(i + 1, Math.max(tplFiltered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setTplActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const t = tplFiltered[tplActive];
      if (t) insertTemplate(t);
      else setTplOpen(false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setTplOpen(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    hideToast();
    try {
      if (curProvider === "kling") {
        const ready = await checkKlingReady();
        if (!ready.ok) {
          showToast(ready.message);
          return;
        }
      } else if (!getApiKey(curProvider) && !isDryRun()) {
        // HTTP provider：没配 Key 且没开 dry-run 就别白提交
        const label =
          providerOptions.find((o) => o.id === curProvider)?.label ||
          curProvider;
        showToast(
          `未配置 ${label} 的 API Key，请到设置面板配置；或开启 dry-run 验证请求构造`,
        );
        return;
      }
      if (!gen.prompt.trim()) {
        showToast("请填写提示词");
        return;
      }
      // 模板闸门：模板原样未改就提交，提醒先编辑锚点（UXP 版同款防呆）
      const gate = matchTemplateGate(gen.prompt, tplMode);
      if (gate) {
        showToast(
          gate.anchor
            ? `模板「${gate.label}」还没改：把「${gate.anchor}」换成你的描述再提交`
            : `模板「${gate.label}」还没修改，请先编辑提示词`,
        );
        return;
      }
      const p = curParams(gen);
      if (isImage) {
        // 图片模式只吃图片参考（视频参考会被可灵拒收）
        const imageRefs = gen.refs.filter((r) => r.type === "reference_image");
        const skipped = gen.refs.length - imageRefs.length;
        await submitImageGeneration(
          {
            model: p.model,
            prompt: gen.prompt.trim(),
            ratio: p.ratio,
            resolution: p.resolution,
            count: Number(p.count) || 1,
            references: imageRefs.map((r) => ({
              type: r.type,
              localPath: r.localPath,
            })),
          },
          {
            providerId: curProvider,
            references: imageRefs.map((r) => ({
              type: r.type,
              localPath: r.localPath,
              fileName: r.fileName,
              sizeBytes: r.sizeBytes,
              durationSeconds: r.durationSeconds,
            })),
          },
        );
        gen.patch({ prompt: "", refs: [] });
        showToast(
          skipped > 0
            ? `已提交生成任务（忽略 ${skipped} 个视频参考素材）`
            : "已提交生成任务",
        );
        return;
      }
      await submitGeneration(
        {
          model: p.model,
          prompt: gen.prompt.trim(),
          ratio: p.ratio,
          duration: Number(p.duration),
          resolution: p.resolution,
          references: gen.refs.map((r) => ({
            type: r.type,
            localPath: r.localPath,
          })),
        },
        {
          providerId: curProvider,
          references: gen.refs.map((r) => ({
            type: r.type,
            localPath: r.localPath,
            fileName: r.fileName,
            sizeBytes: r.sizeBytes,
            durationSeconds: r.durationSeconds,
          })),
        },
      );
      // 提交后清空提示词与素材（保留参数，方便连续生成）
      gen.patch({ prompt: "", refs: [] });
      showToast("已提交生成任务");
    } catch (e: any) {
      showToast(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const p = curParams(gen);
  const modelLabel =
    current?.displayName ||
    current?.modelId ||
    (current ? "无模型" : "模型");
  const paramsSummary = isImage
    ? [p.ratio, p.resolution, p.count ? `${p.count}张` : ""].filter(Boolean).join("·")
    : [p.ratio, p.duration ? `${p.duration}s` : "", p.resolution].filter(Boolean).join("·");

  const fps = seq.fps ? (seq.fps < 1 ? 1 / seq.fps : seq.fps) : 0;

  const switchMode = (mode: GenMode) => {
    if (mode === gen.mode) return;
    gen.patch({ mode, refs: [] });
    setModelOpen(false);
    setParamOpen(false);
    setProviderOpen(false);
    hideToast();
  };

  /** 切 provider：清空模型与参数（收敛 effect 会按新 provider 的值域重选默认档） */
  const switchProvider = (pid: string) => {
    if (pid === curProvider) return;
    gen.patchParams({ provider: pid, model: "" });
    setProviderOpen(false);
    setModelOpen(false);
    setParamOpen(false);
  };

  return (
    <div className="floating-prompt-bar">
      {/* 工具行：模式 tab（左）+ 抓素材（右） */}
      <div className="prompt-toolbar">
        <div className="mode-tabs">
          <button
            className={`mode-tab${isImage ? "" : " active"}`}
            type="button"
            onClick={() => switchMode("video")}
          >
            <span className="tab-icon">🎬</span>
            <span className="tab-label">视频生成</span>
          </button>
          <button
            className={`mode-tab${isImage ? " active" : ""}`}
            type="button"
            onClick={() => switchMode("image")}
            title="文生图 / 图生图（可灵）"
          >
            <span className="tab-icon">🖼</span>
            <span className="tab-label">图片生成</span>
          </button>
        </div>
        <div className="capture-buttons">
          <button
            className="capture-btn"
            type="button"
            disabled={busy}
            onClick={() => grabFrame()}
            title={
              seq.hasSequence && fps > 0
                ? `抓当前播放头画面（第 ${Math.round(
                    (seq.playerPositionSeconds || 0) * fps,
                  )} 帧）作为参考图`
                : "抓当前播放头画面作为参考图"
            }
          >
            🖼 抓帧
          </button>
          <button
            className="capture-btn"
            type="button"
            disabled={busy}
            onClick={() => grabFrame(true)}
            title="抓当前播放头画面并在 Photoshop 中打开；修改完成后点素材上的「修改完成」"
          >
            🎨 抓帧→PS
          </button>
          {!isImage && (
            <button
              className="capture-btn"
              type="button"
              disabled={busy}
              onClick={() => grabClip()}
              title="把序列入出点（I/O）之间的片段导出为参考视频；走 Premiere 内置导出，不依赖 Media Encoder"
            >
              🎞 抓视频
            </button>
          )}
        </div>
      </div>

      {/* 参考素材 */}
      {gen.refs.length > 0 && (
        <div className="ref-list">
          {gen.refs.map((r) => (
            <div className="ref-item" key={r.localPath}>
              <div className="ref-thumb">
                {r.thumb ? (
                  <img src={r.thumb} className="thumb-img" alt={r.fileName} />
                ) : (
                  <span className="ref-icon">
                    {r.type === "reference_video" ? "🎞" : "🖼"}
                  </span>
                )}
              </div>
              <span className="ref-name" title={r.localPath}>
                {r.fileName}
              </span>
              {r.editingInPs ? (
                <>
                  <span className="ref-status ps-editing">✏ PS 中</span>
                  <button
                    className="ps-confirm-btn"
                    type="button"
                    onClick={() => confirmPsEdit(r.localPath)}
                    title="在 PS 中修改完成后点这里：重新读取文件并预上传"
                  >
                    修改完成
                  </button>
                </>
              ) : (
                <span className="ref-status">已就绪</span>
              )}
              <button
                className="remove-btn"
                type="button"
                onClick={() => gen.removeRef(r.localPath)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="prompt-divider" />

      {/* 提示词 */}
      <div className="prompt-textarea-wrap">
        <textarea
          ref={promptRef}
          value={gen.prompt}
          rows={2}
          placeholder={
            isImage
              ? "描述你想生成的图片…（输入 / 可插入提示词模板）"
              : "描述你想生成的视频…（输入 / 可插入提示词模板）"
          }
          onChange={(e) =>
            onPromptInput(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            )
          }
          onKeyDown={onPromptKeyDown}
        />
        {tplOpen && tplFiltered.length > 0 && (
          <div className="tpl-popover">
            {tplFiltered.map((t, i) => (
              <div
                key={t.id}
                className={`tpl-item${i === tplActive ? " active" : ""}`}
                // mousedown 而不是 click：避免 textarea 失焦丢光标
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertTemplate(t);
                }}
              >
                <span className="tpl-label">{t.label}</span>
                <span className="tpl-body">{t.template}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 参数行：provider + 模型 + 参数 + 生成 */}
      <div className="param-row">
        <div className="param-anchor">
          {(() => {
            const curLabel =
              providerOptions.find((o) => o.id === curProvider)?.label ||
              curProvider;
            return (
              <>
                <button
                  className="param-toggle provider-btn"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setProviderOpen((v) => !v);
                    setModelOpen(false);
                    setParamOpen(false);
                  }}
                  title={`生成服务：${curLabel}（可灵走 CLI 无需 Key；其余走 HTTP API，需在设置里配 Key）`}
                >
                  {curLabel}
                </button>

                {/* provider 浮层：CEP webview 原生 <select> 弹不出来，走自定义浮层（同模型选择） */}
                {providerOpen && (
                  <div
                    className="param-popover provider-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {providerOptions.map((o) => (
                      <label
                        key={o.id}
                        className={`radio-item${curProvider === o.id ? " active" : ""}`}
                      >
                        <input
                          type="radio"
                          name="provider"
                          value={o.id}
                          checked={curProvider === o.id}
                          onChange={() => switchProvider(o.id)}
                        />
                        <span>{o.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>

        <div className="param-anchor">
          <button
            className="param-toggle model-btn"
            type="button"
            disabled={!current}
            onClick={() => {
              setModelOpen((v) => !v);
              setParamOpen(false);
              setProviderOpen(false);
            }}
            title={`当前模型：${modelLabel}`}
          >
            {modelLabel}
          </button>

          {/* 模型选择浮层 */}
          {modelOpen && (
            <div
              className="param-popover model-popover"
              onClick={(e) => e.stopPropagation()}
            >
              {curProviderModels.map((m) => (
                <label
                  key={m.modelId}
                  className={`radio-item${p.model === m.modelId ? " active" : ""}`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={m.modelId}
                    checked={p.model === m.modelId}
                    onChange={() => {
                      gen.patchParams({ model: m.modelId });
                      setModelOpen(false);
                    }}
                  />
                  <span>{m.displayName || m.modelId}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="param-anchor">
          <button
            className="param-toggle params-btn"
            type="button"
            disabled={!current}
            onClick={() => {
              setParamOpen((v) => !v);
              setModelOpen(false);
              setProviderOpen(false);
            }}
          >
            {paramsSummary || "参数"}
          </button>

          {/* 参数选择浮层 */}
          {paramOpen && current && (
            <div
              className="param-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="popover-group">
                <div className="group-label">画幅</div>
                <div className="radio-row">
                  {current.ratios.map((r) => (
                    <label
                      key={r}
                      className={`radio-item${p.ratio === r ? " active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="ratio"
                        checked={p.ratio === r}
                        onChange={() => gen.patchParams({ ratio: r })}
                      />
                      <span>{r}</span>
                    </label>
                  ))}
                </div>
              </div>

              {isImage ? (
                <>
                  <div className="popover-group">
                    <div className="group-label">分辨率</div>
                    <div className="radio-row">
                      {current.resolutions.map((r) => (
                        <label
                          key={r}
                          className={`radio-item${p.resolution === r ? " active" : ""}`}
                        >
                          <input
                            type="radio"
                            name="img-resolution"
                            checked={p.resolution === r}
                            onChange={() => gen.patchParams({ resolution: r })}
                          />
                          <span>{r}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {current.counts.length > 0 && (
                    <div className="popover-group">
                      <div className="group-label">张数</div>
                      <div className="radio-row">
                        {current.counts.map((c) => (
                          <label
                            key={c}
                            className={`radio-item${p.count === c ? " active" : ""}`}
                          >
                            <input
                              type="radio"
                              name="image-count"
                              checked={p.count === c}
                              onChange={() => gen.patchParams({ count: c })}
                            />
                            <span>{c}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="popover-group">
                    <div className="group-label">时长</div>
                    <div className="radio-row">
                      {current.durations.map((d) => (
                        <label
                          key={d}
                          className={`radio-item${p.duration === String(d) ? " active" : ""}`}
                        >
                          <input
                            type="radio"
                            name="duration"
                            checked={p.duration === String(d)}
                            onChange={() => gen.patchParams({ duration: String(d) })}
                          />
                          <span>{d}s</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="popover-group">
                    <div className="group-label">分辨率</div>
                    <div className="radio-row">
                      {current.resolutions.map((r) => (
                        <label
                          key={r}
                          className={`radio-item${p.resolution === r ? " active" : ""}`}
                        >
                          <input
                            type="radio"
                            name="resolution"
                            checked={p.resolution === r}
                            onChange={() => gen.patchParams({ resolution: r })}
                          />
                          <span>{r}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <button
          className="primary submit-btn"
          type="button"
          disabled={busy || !current || !gen.prompt.trim()}
          onClick={submit}
        >
          {busy ? "处理中…" : "生成"}
        </button>
      </div>

      {/* 瞬时提示卡片：浮层，出现 3 秒后 1 秒渐隐 */}
      {toast && (
        <div className={`toast-card${toast.leaving ? " leaving" : ""}`}>
          {toast.text}
        </div>
      )}
      {curProvider === "kling" && !env.ready && env.reason && (
        <div className="form-message hint">
          可灵环境未就绪（{env.message}）—— 点右上角 ⚙ 处理。
        </div>
      )}
      {curProvider !== "kling" && isDryRun() && (
        <div className="form-message hint">
          dry-run 已开启：提交会被拦截，仅验证请求构造，不产生真实结果。
        </div>
      )}
      {gen.refs.length > 0 && current && !current.imageInput && (
        <div className="form-message hint">
          当前模型不支持参考图，提交时会报错，请改用支持参考图的模型。
        </div>
      )}
      {isImage && gen.refs.some((r) => r.type === "reference_video") && (
        <div className="form-message hint">
          图片生成仅支持图片参考，视频参考会被忽略。
        </div>
      )}
    </div>
  );
};

/** 当前模式的参数视图（视频 / 图片的值域不同，不能混用） */
interface CurParams {
  model: string;
  ratio: string;
  duration: string;
  resolution: string;
  count: string;
}

/** 统一模型视图：kling 清单与 provider 清单归一后的形状（UI 只消费它） */
interface UiModel {
  modelId: string;
  displayName: string;
  ratios: string[];
  /** 视频侧时长档（秒）；图片侧恒为空 */
  durations: number[];
  resolutions: string[];
  /** 图片侧张数档；视频侧恒为空 */
  counts: string[];
  defaultResolution?: string;
  defaultRatio?: string;
  /** 是否支持参考素材（图 / 视频 / 音频任一） */
  imageInput: boolean;
}

/** 模型收敛：已在清单里就保留；否则优先服务端默认，再退首项 */
function convergeModel(cur: string, models: UiModel[], def: string): string {
  if (cur && models.some((m) => m.modelId === cur)) return cur;
  if (def && models.some((m) => m.modelId === def)) return def;
  return models[0]?.modelId || "";
}

/** 取当前模式的参数桶（缺失的字段补空串，调用方不用判空） */
function curParams(state: {
  mode: GenMode;
  video: { model: string; ratio: string; duration: string; resolution: string };
  image: { model: string; ratio: string; resolution: string; count: string };
}): CurParams {
  return state.mode === "image"
    ? { ...state.image, duration: "" }
    : { ...state.video, count: "" };
}

// ---- 自动填画幅比的工具（自 UXP 版 useReferences.ts 移植） ----

function gcd(a: number, b: number): number {
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** 宽高 → 最简整数比字符串（1920x1080 → "16:9"） */
function ratioStringFromSize(w: number, h: number): string | null {
  if (!w || !h) return null;
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/**
 * 把素材比值与模型合法 ratio 档匹配，返回最接近的一档。
 * - 排除 "adaptive"（不是具体比值）
 * - 精确命中直接返回；否则按 |实际比值 − 候选比值| 最小
 * - 候选缺失/无法解析时返回 null（不填）
 */
function pickClosestRatio(
  actual: string,
  candidates: readonly string[] | undefined | null,
): string | null {
  if (!candidates || candidates.length === 0) return null;
  const valid = candidates.filter((r) => r !== "adaptive");
  if (valid.length === 0) return null;
  const exact = valid.find((r) => r === actual);
  if (exact) return exact;
  const m = actual.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const ar = Number(m[1]) / Number(m[2]);
  let best: { ratio: string; diff: number } | null = null;
  for (const r of valid) {
    const cm = r.match(/^(\d+):(\d+)$/);
    if (!cm) continue;
    const diff = Math.abs(ar - Number(cm[1]) / Number(cm[2]));
    if (!best || diff < best.diff) best = { ratio: r, diff };
  }
  return best?.ratio ?? null;
}
