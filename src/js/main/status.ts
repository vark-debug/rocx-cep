/**
 * 记录状态展示（Panel 层）
 *
 * 文案与配色对齐 RocX（UXP 版）useRecordActions.statusOf。
 * 单独成文件是为了让 React Fast Refresh 生效（组件文件只能导出组件）。
 */
import type { GenerationRecord } from "../../shared/types";

/** 状态 → 文案 + 颜色 */
export function statusOf(rec: GenerationRecord): {
  label: string;
  color: string;
} {
  switch (rec.status) {
    case "pending":
      if (rec.pendingStage === "preparing") {
        return { label: "准备素材中", color: "#f6d55c" };
      }
      if (rec.pendingStage === "submitting") {
        return { label: "提交中", color: "#f6d55c" };
      }
      return { label: "排队中", color: "#f6d55c" };
    case "generating":
      return { label: "生成中", color: "#4b9cf5" };
    case "generated":
      return { label: "已生成", color: "#3caea3" };
    case "imported":
      return { label: "已导入", color: "#3caea3" };
    case "failed":
      return { label: "失败", color: "#d9534f" };
    default:
      return { label: rec.status, color: "#888" };
  }
}
