/**
 * Premiere Pro host 层入口（ExtendScript / ECMAScript 3）
 *
 * 本阶段保留四个入口（docs 第 1 节 v0.1.0 范围 + 抓视频）：
 *   - getSequenceInfo：活动工程 / 序列信息（ticks、画幅、帧率、轨道数）
 *   - importFiles：把生成结果导入项目面板，并回传定位到的素材条目
 *   - exportFrame：抓当前序列的指定帧为 PNG（参考图素材）
 *   - exportSequenceClip：按序列入出点导出片段为 MP4（参考视频素材，不依赖 AME）
 *
 * 红线：
 *   - 只能是 ES3 语法 + ES3 内建方法（无 map/filter/forEach/trim/Array.isArray…）
 *   - host 端没有原生 JSON（json2.js polyfill 已由 index.ts @include 进来）
 *   - 不做网络请求、不做业务逻辑、不做长循环（重活放 Node 层）
 */
import { ticksToTime } from "./ppro-utils";

/**
 * 取序列的真实帧率。
 *
 * ⚠ ExtendScript 的坑：`videoFrameRate` 是个 Time 对象，
 *   它的 `seconds` 返回的是 **1 / fps**（25fps 的序列 → 0.04），
 *   必须取倒数才是帧率。ppro-utils 的 getItemFrameRate 也是这么写的。
 */
const getRealFps = (seq: Sequence): number => {
  try {
    const v = seq.getSettings().videoFrameRate.seconds;
    if (!v || v <= 0) return 0;
    return 1 / v;
  } catch (e) {
    return 0;
  }
};

/**
 * 让出主线程一小段时间（等待项目面板刷新）。
 *
 * 用 ExtendScript 的 `$.sleep()` —— 它会把控制权交还宿主应用，
 * 不会像忙等那样冻结 Premiere 的 UI。
 * 万一该宿主没有 `$.sleep`（极端情况），直接返回：宁可少等几轮，
 * 也不要用忙等把主线程卡住。
 */
const sleepMs = (ms: number): void => {
  try {
    //@ts-ignore
    if (typeof $ !== "undefined" && typeof $.sleep === "function") {
      //@ts-ignore
      $.sleep(ms);
    }
  } catch (e) {
    // ignore
  }
};

/**
 * 路径归一化（用于比较「导入的媒体路径」和「要导入的路径」）。
 *
 * - 去 file:// 前缀
 * - 反斜杠统一成正斜杠
 * - URI 解码（项目面板返回的路径可能是百分号编码的）
 * - Windows 下大小写不敏感 → 转小写
 */
const normalizePath = (p: string): string => {
  if (!p) return "";
  let s = String(p);
  if (s.indexOf("file://") === 0) s = s.substring(7);
  s = s.replace(/\\/g, "/");
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // 不是合法 URI 就保持原样
  }
  try {
    //@ts-ignore
    if (typeof $ !== "undefined" && $.os === "Windows") s = s.toLowerCase();
  } catch (e) {
    // ignore
  }
  return s;
};

/** 递归遍历项目面板，收集媒体路径命中的条目 */
const collectItemsByPaths = (paths: string[]): any[] => {
  const targets: any = {};
  for (let i = 0; i < paths.length; i++) {
    const n = normalizePath(paths[i]);
    if (n) targets[n] = true;
  }

  const found: any[] = [];
  const root = app.project.rootItem;
  if (!root) return found;

  const walk = (item: ProjectItem): void => {
    if (!item || !item.children) return;
    const num = item.children.numItems;
    for (let i = 0; i < num; i++) {
      const child = item.children[i];
      if (!child) continue;
      let mediaPath = "";
      try {
        mediaPath = normalizePath(child.getMediaPath());
      } catch (e) {
        mediaPath = "";
      }
      if (
        mediaPath &&
        Object.prototype.hasOwnProperty.call(targets, mediaPath)
      ) {
        found.push({
          name: child.name,
          nodeId: child.nodeId,
          mediaPath: mediaPath,
        });
      } else if (child.children && child.children.numItems > 0) {
        walk(child);
      }
    }
  };
  walk(root);
  return found;
};

/**
 * 活动工程 / 序列信息。
 *
 * ⚠ `app.project.activeSequence` 可能为 null（没有打开序列 / 没有工程），
 *   所有序列相关字段都要先判空。
 */
export const getSequenceInfo = (): any => {
  try {
    const project = app.project;
    if (!project) {
      return { ok: false, error: "没有打开的工程", hasSequence: false };
    }

    const result: any = {
      ok: true,
      // host 脚本版本标记：改 host 层后必须重启 Premiere 才生效，
      // 面板显示这个值就能一眼确认宿主跑的是不是最新脚本。
      hostApi: 3,
      projectPath: project.path || "",
      projectName: project.name || "",
      hasSequence: false,
    };

    const seq = project.activeSequence;
    if (!seq) {
      result.message = "当前没有活动序列";
      return result;
    }

    result.hasSequence = true;
    result.sequenceName = seq.name;
    result.sequenceId = seq.sequenceID;

    const settings = seq.getSettings();
    result.width = settings.videoFrameWidth;
    result.height = settings.videoFrameHeight;
    result.fps = getRealFps(seq);
    result.videoTrackCount = seq.videoTracks.numTracks;
    result.audioTrackCount = seq.audioTracks.numTracks;

    const inTime = seq.getInPointAsTime();
    const outTime = seq.getOutPointAsTime();
    result.inPointTicks = inTime.ticks;
    result.outPointTicks = outTime.ticks;
    result.inPointSeconds = inTime.seconds;
    result.outPointSeconds = outTime.seconds;

    const player = seq.getPlayerPosition();
    result.playerPositionSeconds = player.seconds;

    return result;
  } catch (e: any) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
      hasSequence: false,
    };
  }
};

/**
 * 把文件导入项目面板，并回传定位到的素材条目。
 *
 * ⚠ `app.project.importFiles()` **没有返回值**，导入后的 projectItem
 *   只能靠「按媒体路径在项目面板里找」的方式定位（docs 3.5）。
 *   导入是同步的，但项目面板 UI 的刷新可能有延迟，所以这里做有限轮询
 *   （最多 20 轮 × 100ms），轮询期间用 `$.sleep` 让出主线程。
 */
export const importFiles = (paths: string[]): any => {
  try {
    if (!paths || paths.length === 0) {
      return { ok: false, error: "没有待导入的文件", items: [] };
    }
    if (!app.project) {
      return { ok: false, error: "没有打开的工程", items: [] };
    }

    // suppressUI = true：不弹导入对话框
    const imported = app.project.importFiles(paths, true);
    if (!imported) {
      return { ok: false, error: "导入失败（importFiles 返回 false）", items: [] };
    }

    let items: any[] = [];
    for (let round = 0; round < 20; round++) {
      items = collectItemsByPaths(paths);
      if (items.length >= paths.length) break;
      sleepMs(100);
    }

    if (items.length === 0) {
      return {
        ok: false,
        error: "导入已执行，但未能在项目面板定位到素材",
        items: [],
      };
    }
    return { ok: true, items: items };
  } catch (e: any) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
      items: [],
    };
  }
};

/**
 * 按序列当前的「时间显示格式」格式化一个时间点。
 *
 * ⚠⚠ 这是抓帧能对上的关键 —— `exportFramePNG` 的入参语义
 *   跟随 `videoDisplayFormat` 变：
 *     画框模式（videoDisplayFormat=109）→ "1502"（帧号）
 *     时间码模式（videoDisplayFormat=103）→ "00:00:50:02"（时码）
 *   形态传错**不报错**，只会静默导出**别的帧**。
 *
 * 用 Adobe 自己的 `Time.getFormatted()` 来格式化 ——
 * 它和 QE 的 CTI.timecode 是同一套语义，不会错位。
 * 自己手拼帧号/时码就会踩上面那个坑。
 */
const formatForDisplay = (t: Time, st: any): string => {
  try {
    const s = t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
    return s ? String(s) : "";
  } catch (e) {
    return "";
  }
};

/**
 * 自算时码字符串 "HH:MM:SS:FF"（仅用于诊断显示，不参与导出）。
 */
const buildTimecode = (
  frameNumber: number,
  fps: number,
  seconds: number,
): string => {
  const pad = (n: number, w: number): string => {
    let s = String(Math.floor(n));
    while (s.length < w) s = "0" + s;
    return s;
  };
  const roundedFps = Math.max(1, Math.round(fps));
  const ff = frameNumber % roundedFps;
  const totalSec = Math.floor(seconds);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return (
    pad(hh, 2) + ":" + pad(mm, 2) + ":" + pad(ss, 2) + ":" + pad(ff, 2)
  );
};

/**
 * 求目标时间点（相对序列起点）。
 *
 * 优先用 DOM 的 `getPlayerPosition()` —— 官方 DOM API，语义就是「当前播放头位置」。
 * 不依赖 QE 的 `CTI`：CTI 在面板操作时不保证与 UI 播放头同步。
 */
const resolveTargetTime = (seq: Sequence, args: any): Time | null => {
  try {
    if (args.ticks) {
      return ticksToTime(String(args.ticks));
    }
    if (typeof args.seconds === "number") {
      const t = new Time();
      t.seconds = args.seconds;
      return t;
    }
    return seq.getPlayerPosition();
  } catch (e) {
    return null;
  }
};

/**
 * 抓帧：把当前活动序列的某一帧导出为 PNG。
 *
 * 实现路径（Adobe 官方样例，已核实）：
 *   app.enableQE() → qe.project.getActiveSequence() → exportFramePNG(frame, path)
 *
 * ⚠⚠ 已实测确认的三条硬约束（踩过坑，别再改回去）：
 *
 *   1. 入参的**语义跟随序列的时间显示格式**（`videoDisplayFormat`）：
 *        画框模式 → "1502"（帧号）
 *        时间码模式 → "00:00:50:02"（时码）
 *      传错形态**不报错**，只会静默导出**别的帧** ——
 *      实测同一时刻（雪地镜头）传帧号会导出另一个镜头（城市）。
 *      所以必须用 Adobe 自己的格式化函数按当前显示格式产出入参，
 *      不能自己拼帧号。
 *
 *   2. 输出路径**不要带扩展名** —— Premiere 会自己追加 `.png`，
 *      传 `a.png` 会落成 `a.png.png`。
 *
 *   3. `exportFramePNG()` **不是同步的** —— 调用返回时文件还没写完，
 *      「文件是否落地」由 Node 层轮询判定。
 */
export const exportFrame = (args: any): any => {
  try {
    if (!args || !args.outputPath) {
      return { ok: false, error: "缺少输出路径" };
    }

    if (typeof app.enableQE === "function") {
      app.enableQE();
    }
    if (typeof qe === "undefined" || !qe) {
      return { ok: false, error: "QE DOM 不可用（app.enableQE 失败）" };
    }

    const qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      return { ok: false, error: "当前没有活动序列" };
    }
    const domSeq = app.project.activeSequence;
    if (!domSeq) {
      return { ok: false, error: "当前没有活动序列" };
    }

    const st = domSeq.getSettings();
    const fps = getRealFps(domSeq);
    const time = resolveTargetTime(domSeq, args);
    const domFrame = time && fps > 0 ? Math.round(time.seconds * fps) : -1;

    const cti = qeSeq.CTI;
    const ctiSecs = cti && isFinite(cti.secs) ? cti.secs : -1;
    const ctiUsable =
      !!time && ctiSecs >= 0 && Math.abs(ctiSecs - time.seconds) < 0.5;

    if (!time || domFrame < 0) {
      return { ok: false, error: "无法确定目标帧号" };
    }

    // ⚠⚠ 入参必须按「当前显示格式」格式化 ——
    //    exportFramePNG 的入参语义随 videoDisplayFormat 变：
    //      画框模式吃 "1502"，时间码模式吃 "00:00:50:02"。
    //    形态传错不报错，只是静默导出**别的帧**（实测踩过）。
    const frameArg = formatForDisplay(time, st);
    if (!frameArg) {
      return { ok: false, error: "无法按当前显示格式格式化目标时间" };
    }

    // ExtendScript 的 File 与浏览器 DOM 的 File 同名不同义：
    // 这里要的是 ExtendScript 的 fsName（平台原生路径分隔符）。
    const fsName = (new (File as any)(args.outputPath) as { fsName: string })
      .fsName;

    qeSeq.exportFramePNG(frameArg, fsName);

    // 诊断信息
    const qeIn = qeSeq.inPoint;
    const qeOut = qeSeq.outPoint;
    // 导出后再读一次 CTI：如果被重置成 0，说明它导出的是「自己设定的位置」
    const ctiAfter = qeSeq.CTI;

    return {
      ok: true,
      path: fsName,
      frameNumber: domFrame,
      /** 序列画幅：面板用它做「首次抓帧自动填画幅比」 */
      width: st.videoFrameWidth,
      height: st.videoFrameHeight,
      /** 实际送进 exportFramePNG 的参数（帧号） */
      frameArg: frameArg,
      /** 参照用的时码（不送出） */
      timecode: buildTimecode(domFrame, fps, time ? time.seconds : 0),
      qeSeqName: qeSeq.name,
      domSeqName: domSeq.name,
      qeTimecode: cti ? String(cti.timecode) : "",
      qeFrames: cti && isFinite(cti.frames) ? Math.round(cti.frames) : -1,
      qeSecs: ctiSecs,
      ctiSynced: ctiUsable,
      /** 导出后 CTI 的帧号（若被重置成 0，说明导出的是它自己设定的位置） */
      ctiAfterFrames:
        ctiAfter && isFinite(ctiAfter.frames)
          ? Math.round(ctiAfter.frames)
          : -1,
      domSecs: time ? time.seconds : -1,
      fps: fps,
      domVideoDisplayFormat: domSeq.getSettings().videoDisplayFormat,
      qeInTimecode: qeIn ? String(qeIn.timecode) : "",
      qeInFrames: qeIn && isFinite(qeIn.frames) ? Math.round(qeIn.frames) : -1,
      qeOutTimecode: qeOut ? String(qeOut.timecode) : "",
      qeOutFrames: qeOut && isFinite(qeOut.frames) ? Math.round(qeOut.frames) : -1,
      // QE 的 player.totalFrames 在序列未播放时是 "INVALID"，
      // 用出点 − 入点自己算更可靠。
      qeTotalFrames:
        qeIn && qeOut && isFinite(qeIn.frames) && isFinite(qeOut.frames)
          ? String(Math.round(qeOut.frames) - Math.round(qeIn.frames))
          : "",
    };
  } catch (e: any) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
    };
  }
};

/**
 * 抓视频：按序列入出点（I/O）把片段导出为 MP4。
 *
 * 用 `sequence.exportAsMediaDirect(outputPath, presetPath, 1)`：
 *   - Premiere **内置导出管线**（界面上显示导出进度条），完全不依赖 AME；
 *   - 第三参 1 = ENCODE_IN_TO_OUT（0=全序列 2=工作区条，实测 2 在未设工作区条时会弹导出对话框）；
 *   - 同步阻塞：返回 "No Error" 时文件已写完（实测 3s 4K 片段 ~2s）。
 *
 * ⚠ 错误信息**只能是 ASCII**：evalScript 回传的字符串按系统代码页解码，
 *   host 层的中文到面板必然乱码（踩过坑）。中文文案由 Node 层按错误码映射。
 */
export const exportSequenceClip = (args: any): any => {
  try {
    if (!args || !args.outputPath || !args.eprPath) {
      return { ok: false, error: "missing_args" };
    }
    if (!app.project) {
      return { ok: false, error: "no_project" };
    }
    const seq = app.project.activeSequence;
    if (!seq) {
      return { ok: false, error: "no_sequence" };
    }

    // 入出点校验：出点必须晚于入点（未设置 I/O 时 PR 返回 0/末点，
    // 这里只拦「无效」组合，提示用户先按 I/O 设置）
    let inSec = -1;
    let outSec = -1;
    try {
      inSec = seq.getInPointAsTime().seconds;
      outSec = seq.getOutPointAsTime().seconds;
    } catch (e) {
      return { ok: false, error: "io_read_failed" };
    }
    if (!(outSec > inSec) || inSec < 0 || outSec <= 0) {
      return { ok: false, error: "no_io_points" };
    }

    const fsOut = (new (File as any)(args.outputPath) as { fsName: string })
      .fsName;
    const fsEpr = (new (File as any)(args.eprPath) as { fsName: string })
      .fsName;

    // 预设存在性：exportAsMediaDirect 对无效预设会**弹导出对话框**（等用户点），
    // 这违背自动化 —— 所以先把文件查一遍，没有就直接报错。
    const eprFile = new (File as any)(fsEpr);
    if (!eprFile.exists) {
      return { ok: false, error: "missing_preset:" + fsEpr };
    }

    const ret = seq.exportAsMediaDirect(fsOut, fsEpr, 1);
    const retStr = String(ret);
    if (retStr !== "No Error") {
      return { ok: false, error: "export_failed:" + retStr };
    }

    // 序列画幅：面板用它做「首次参考自动填画幅比」
    let width = 0;
    let height = 0;
    try {
      const st = seq.getSettings();
      width = st.videoFrameWidth;
      height = st.videoFrameHeight;
    } catch (e) {
      // 读不到就不填
    }

    return {
      ok: true,
      path: fsOut,
      durationSeconds: outSec - inSec,
      width: width,
      height: height,
    };
  } catch (e: any) {
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
    };
  }
};
