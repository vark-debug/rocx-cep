/**
 * 可灵环境快照（Node 层）
 *
 * 为什么需要快照：
 *   CLI 定位要拉起好几个子进程（找 node → 扫 npm 全局根 → 探测 cli.js），
 *   实测 >1s；再叠一次 `who_am_i` 网络请求。面板打开时如果干等，
 *   用户会看到一片空白 —— 分不清是「还没检测」还是「检测不出」。
 *
 * 做法与 RocX（UXP 版）一致：
 *   - 上次检测结果落盘（插件私有数据目录）
 *   - 面板打开时先读快照渲染 UI（瞬间可用），再后台跑一次真实检测覆盖
 *
 * 失败态（未装 CLI / 未登录）也会落盘 —— 用户可能刚装好 / 刚登录，
 * 所以读取后**必须**再跑一次真实检测。
 */
import { fs, path } from "../../lib/cep/node";
import { getPluginDataDir } from "../storage/paths";
import type { KlingEnvState } from "../../../shared/types";
import type { KlingModelCatalog } from "./wireFormat";

/** 快照文件名 */
const SNAPSHOT_FILE = "kling-env.json";

/** 快照内容 */
export interface KlingEnvSnapshot extends KlingEnvState {
  /**
   * 已解析的模型清单。
   *
   * ⚠ 存的是**已解析**的 catalog（`{ [tool]: { defaultModel, models } }`），
   *   与 `parseKlingCatalog` 的输入形状（`{ availableModels: {...} }`）不同，
   *   恢复时不能再过一遍 parseKlingCatalog。
   */
  catalog?: KlingModelCatalog;
}

/** 快照文件绝对路径 */
function snapshotPath(): string {
  const dir = getPluginDataDir();
  if (!dir) return "";
  return path.join(dir, SNAPSHOT_FILE);
}

/** 写快照；失败不影响主流程（只是下次没有缓存可用） */
export function persistEnvSnapshot(
  env: KlingEnvState,
  catalog: KlingModelCatalog | null,
): void {
  const file = snapshotPath();
  if (!file) return;
  try {
    const payload: KlingEnvSnapshot = { ...env, catalog: catalog ?? undefined };
    fs.writeFileSync(file, JSON.stringify(payload), "utf-8");
  } catch (e) {
    console.warn("[kling] 环境快照写入失败:", e);
  }
}

/** 读快照；没有可用快照时返回 null */
export function restoreEnvSnapshot(): KlingEnvSnapshot | null {
  const file = snapshotPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const txt = fs.readFileSync(file, "utf-8");
    if (!txt) return null;
    const snap = JSON.parse(txt) as KlingEnvSnapshot;
    return snap && typeof snap === "object" ? snap : null;
  } catch (e) {
    console.warn("[kling] 环境快照读取失败:", e);
    return null;
  }
}

/** 删快照（退出登录 / 换账号后清掉旧余额与模型清单） */
export function clearEnvSnapshot(): void {
  const file = snapshotPath();
  if (!file) return;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    console.warn("[kling] 环境快照删除失败:", e);
  }
}
