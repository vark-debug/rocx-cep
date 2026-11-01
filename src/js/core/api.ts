/**
 * Panel ↔ Node 层 的类型化接口面（唯一入口）
 *
 * 面板（src/js/main）只允许从这里 import —— 不直接碰 cli / fs / child_process。
 * CEP 的 Node 层与面板同进程（`--mixed-context`），所以这里的「桥」就是
 * 普通的 ES module import，不需要 Comlink / 消息协议。
 */
export {
  // 可灵环境
  subscribeKlingState,
  getKlingEnv,
  getKlingModels,
  getKlingImageModels,
  getKlingDefaultModel,
  getKlingImageDefaultModel,
  bootstrapKlingEnv,
  refreshKlingEnvInBackground,
  startKlingLogin,
  logoutKling,
  checkKlingReady,
  KlingProviderError,
} from "./kling/provider";

export { installKlingCli } from "./kling/installer";
export type { InstallResult, InstallProgress } from "./kling/installer";

export {
  subscribeGeneration,
  getRecords,
  getProjectInfo,
  getSequenceInfoSnapshot,
  syncProject,
  submitGeneration,
  submitImageGeneration,
  importRecordToProject,
  removeRecord,
  retryGeneration,
} from "./generation";
export type { ProjectInfo } from "./generation";
export type {
  GenerationRecord,
  GenerationRecordStatus,
  GenerationReference,
  GenerationKind,
  KlingImageModelDescriptor,
  KlingModelDescriptor,
} from "../../shared/types";

export { captureClip, captureFrame, warmUpReference } from "./capture";
export type { CaptureFrameResult } from "./capture";
export { testReport as testWebhookReport } from "./webhook";

export { openInPhotoshop } from "./ps";
export type { OpenPsResult } from "./ps";
export { invalidateKlingUpload } from "./kling/preUpload";

export { registerMedia } from "./storage/mediaServer";
export { readImageDataUrl } from "./storage/image";

// ---------- HTTP provider（minimax / runninghub / ark） ----------

export {
  ensureProvidersRegistered,
  isDryRun,
  setDryRun,
} from "./providers";
import {
  ensureProvidersRegistered,
  videoProviderOptions as _videoProviderOptions,
  imageProviderOptions as _imageProviderOptions,
  listModels as _listProviderModels,
  listImageModels as _listProviderImageModels,
} from "./providers";
export type { ProviderOption, ProviderModelDescriptor } from "./providers";

/** 选项/清单查询前确保三家已注册（注册幂等）—— 否则面板首屏只有 kling 一项 */
export function videoProviderOptions() {
  ensureProvidersRegistered();
  return _videoProviderOptions();
}

export function imageProviderOptions() {
  ensureProvidersRegistered();
  return _imageProviderOptions();
}

export function listProviderModels(providerId?: string) {
  ensureProvidersRegistered();
  return _listProviderModels(providerId);
}

export function listProviderImageModels(providerId?: string) {
  ensureProvidersRegistered();
  return _listProviderImageModels(providerId);
}

// 图片「智能」档的纯计算工具（无 IO，面板展示 / 回填反推档位用）
export {
  clampToApiMax,
  describeRatio,
  ratioToSize,
} from "./providers/runninghub/wireFormat";

export {
  getApiKey,
  setApiKey,
  listConfiguredProviders,
} from "./storage/apiKeys";

// ---------- webhook ----------

export {
  getWebhookConfig,
  saveWebhookConfig,
} from "./webhook";
export type { WebhookConfig } from "./webhook";
