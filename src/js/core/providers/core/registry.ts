/**
 * Provider 注册中心（对齐 UXP 版 registry.ts）
 *
 * 视频（VideoGenProvider）与图片（ImageGenProvider）各一张表，互不干扰。
 * 可灵是 CLI 路径不经此注册表（generation.ts 里显式分流），
 * 这里只注册 HTTP 直连的三家：minimax / runninghub / ark。
 */
import type { VideoGenProvider } from "./contracts";
import type { ImageGenProvider } from "./contracts";
import type { ProviderModelDescriptor } from "./types";

const providers = new Map<string, VideoGenProvider>();
const imageProviders = new Map<string, ImageGenProvider>();

export function registerProvider(provider: VideoGenProvider): void {
  providers.set(provider.providerId, provider);
}

export function registerImageProvider(provider: ImageGenProvider): void {
  imageProviders.set(provider.providerId, provider);
}

export function getVideoProvider(id: string): VideoGenProvider | null {
  return providers.get(id) ?? null;
}

export function getImageProvider(id: string): ImageGenProvider | null {
  return imageProviders.get(id) ?? null;
}

export function listVideoProviders(): VideoGenProvider[] {
  return Array.from(providers.values());
}

export function listImageProviders(): ImageGenProvider[] {
  return Array.from(imageProviders.values());
}

export function listModels(providerId?: string): ProviderModelDescriptor[] {
  if (providerId) {
    return getVideoProvider(providerId)?.models ?? [];
  }
  const all: ProviderModelDescriptor[] = [];
  for (const p of providers.values()) all.push(...p.models);
  return all;
}

export function listImageModels(providerId?: string): ProviderModelDescriptor[] {
  if (providerId) {
    return getImageProvider(providerId)?.models ?? [];
  }
  const all: ProviderModelDescriptor[] = [];
  for (const p of imageProviders.values()) all.push(...p.models);
  return all;
}

/** 视频 provider 选择器取值（kling 永远在首项 —— CLI 链路无需 API Key） */
export interface ProviderOption {
  id: string;
  label: string;
}

export function videoProviderOptions(): ProviderOption[] {
  return [
    { id: "kling", label: "可灵" },
    ...listVideoProviders().map((p) => ({ id: p.providerId, label: p.displayName })),
  ];
}

export function imageProviderOptions(): ProviderOption[] {
  return [
    { id: "kling", label: "可灵" },
    ...listImageProviders().map((p) => ({ id: p.providerId, label: p.displayName })),
  ];
}
