/**
 * Providers 模块入口：注册三家 HTTP 直连 provider 并导出公共 API
 *
 * 可灵走 CLI（src/js/core/kling/），不经此注册表。
 * generation.ts 按 record.params.provider 分流：
 *   - "kling"（默认）→ 现有 CLI 链
 *   - 其他 → 从这里取 provider 实例走 HTTP 链
 */
import { registerImageProvider, registerProvider } from "./core/registry";
import { MiniMaxProvider } from "./minimax/MiniMaxProvider";
import { RunningHubProvider } from "./runninghub/RunningHubProvider";
import { ArkProvider } from "./ark/ArkProvider";

let registered = false;

/** 幂等注册（面板重载后模块重新求值，重注册也无害，但保持幂等更稳） */
export function ensureProvidersRegistered(): void {
  if (registered) return;
  registerProvider(new MiniMaxProvider());
  registerImageProvider(new RunningHubProvider());
  registerImageProvider(new ArkProvider());
  registered = true;
}

export {
  getVideoProvider,
  getImageProvider,
  listVideoProviders,
  listImageProviders,
  listModels,
  listImageModels,
  videoProviderOptions,
  imageProviderOptions,
} from "./core/registry";
export type { ProviderOption } from "./core/registry";
export type {
  VideoGenProvider,
  ImageGenProvider,
  ProviderUploadRequest,
  ProviderUploadResult,
} from "./core/contracts";
export type {
  ImageGenCreateRequest,
  ProviderCapability,
  ProviderModelDescriptor,
  ProviderParamConstraints,
  ProviderRef,
  VideoGenCreateRequest,
  VideoGenCreateResponse,
  VideoGenErrorParsed,
  VideoGenQueryResponse,
} from "./core/types";
export { VideoGenError } from "./core/errors";
export {
  isDryRun,
  setDryRun,
  isDryRunTaskId,
  DRYRUN_TASK_PREFIX,
} from "./core/dryRun";
