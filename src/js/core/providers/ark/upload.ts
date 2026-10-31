/**
 * Ark（火山方舟）provider：素材上传 no-op（base64 直传）+ 下载走通用逻辑
 *
 * UXP 版透明画布用 DOM canvas 生成 —— Node 层没有 canvas，
 * 改为手写 PNG 结构（zlib deflate 全零 RGBA，见 ../core/png.ts）。
 */
import type {
  ProviderUploadRequest,
  ProviderUploadResult,
} from "../core/contracts";
import { makeTransparentPngDataUri } from "../core/png";

export function arkUploadFile(
  req: ProviderUploadRequest,
): Promise<ProviderUploadResult> {
  // no-op：Ark 提交时直接内联 base64，无需上传
  console.log(
    `[ark-upload] no-op（base64 直传，不上传） file="${req.fileName}"`,
  );
  return Promise.resolve({ ok: true, fileId: `inline:${req.fileName}` });
}

/** 生成全透明画布 data URI（透明底图生图的输入图） */
export function arkTransparentCanvas(
  width: number,
  height: number,
): string {
  return makeTransparentPngDataUri(width, height);
}
