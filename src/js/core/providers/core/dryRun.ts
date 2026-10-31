/**
 * dry-run 模式（对齐 UXP 版 __ROCX_DRY_RUN__）
 *
 * 用途：无 API Key 时验证「请求构造 + provider 路由 + 素材分流」全链。
 * 开启后 provider 的 create* 只构造请求体并打印，返回 mock taskId；
 * queryTask 对 dry-run 任务直接返回 failed（明确标注模拟任务）。
 *
 * 开关：设置面板（写 storage）或 console 调 setDryRun(true)。
 * 状态存模块级变量 —— CEP 面板重载后回到默认（默认关）。
 */
import type { VideoGenCreateResponse } from "./types";

let dryRun = false;

export function setDryRun(on: boolean): void {
  dryRun = on;
  console.log(`[dry-run] ${on ? "开启" : "关闭"}`);
}

export function isDryRun(): boolean {
  return dryRun;
}

/** dry-run 模式下的 mock 提交结果 */
export function dryRunCreateResponse(tag: string): VideoGenCreateResponse {
  const taskId = `dryrun_${Date.now().toString(36)}`;
  console.log(
    `%c[dry-run:${tag}] 提交已拦截（未发送网络请求），mock taskId=${taskId}`,
    "color:#b8860b;font-weight:bold",
  );
  return { taskId, raw: { dryRun: true } };
}

/** dry-run 任务 id 前缀 */
export const DRYRUN_TASK_PREFIX = "dryrun_";

/** 是否 dry-run 任务 id */
export function isDryRunTaskId(taskId: string): boolean {
  return taskId.startsWith(DRYRUN_TASK_PREFIX);
}
