/**
 * Node 层 → Host 层（ExtendScript）桥
 *
 * 只有这里能碰 `evalTS` —— 上层（provider / 记录 / 面板）只调本模块的函数，
 * 不知道 evalScript 的存在，更不会把用户输入拼进 evalScript 字符串。
 *
 * ⚠ evalScript 的返回是**乱序**的（docs 3.2）：并发调用时响应可能不按请求顺序到达。
 *   本模块所有入口都是「一次一个」的串行语义，调用方需自行排队，
 *   不要在同一个 Promise.all 里并发调多个 host 入口。
 */
import { evalTS } from "../lib/utils/bolt";
import type {
  ExportFrameArgs,
  ExportFrameResult,
  ExportSequenceClipArgs,
  ExportSequenceClipResult,
  ImportFilesResult,
  SequenceInfo,
} from "../../shared/types";

/** 活动工程 / 序列信息 */
export async function getSequenceInfo(): Promise<SequenceInfo> {
  const res = await evalTS("getSequenceInfo");
  return res as SequenceInfo;
}

/** 把文件导入项目面板 */
export async function importFiles(paths: string[]): Promise<ImportFilesResult> {
  const res = await evalTS("importFiles", paths);
  return res as ImportFilesResult;
}

/** 抓帧（导出 PNG） */
export async function exportFrame(
  args: ExportFrameArgs,
): Promise<ExportFrameResult> {
  const res = await evalTS("exportFrame", args);
  return res as ExportFrameResult;
}

/**
 * 抓视频（按序列入出点导出 MP4）。
 *
 * ⚠ host 端 `exportAsMediaDirect` 是**同步阻塞**的：导出期间 Premiere
 *   主线程被占用（界面显示导出进度条），片段越长等待越久 ——
 *   调用方应把按钮置 busy 并提示「导出中」。
 */
export async function exportSequenceClip(
  args: ExportSequenceClipArgs,
): Promise<ExportSequenceClipResult> {
  const res = await evalTS("exportSequenceClip", args);
  return res as ExportSequenceClipResult;
}
