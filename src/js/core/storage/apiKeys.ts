/**
 * per-provider API Key 存储（Node 层）
 *
 * 放插件数据目录（getPluginDataDir）的 api-keys.json，与生成记录分离 ——
 * Key 是全局凭据，不应随工程目录走。
 *
 * 文件权限 0600：本地凭据只留给当前用户。
 */
import { fs, path } from "../../lib/cep/node";
import { getPluginDataDir } from "./paths";

interface KeyStore {
  [providerId: string]: string;
}

let cache: KeyStore | null = null;

function storePath(): string {
  const dir = getPluginDataDir();
  if (!dir) return "";
  return path.join(dir, "api-keys.json");
}

function load(): KeyStore {
  if (cache) return cache;
  const file = storePath();
  if (!file) return {};
  try {
    if (!fs.existsSync(file)) return {};
    const txt = fs.readFileSync(file, "utf-8");
    const j = JSON.parse(txt) as KeyStore;
    cache = j && typeof j === "object" ? j : {};
  } catch (e) {
    console.warn("[apiKeys] 读取失败:", e);
    cache = {};
  }
  return cache;
}

function save(store: KeyStore): void {
  const file = storePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    cache = store;
  } catch (e) {
    console.warn("[apiKeys] 写入失败:", e);
  }
}

/** 读某 provider 的 API Key；无则空串 */
export function getApiKey(providerId: string): string {
  return load()[providerId] || "";
}

/** 写某 provider 的 API Key（空串 = 删除） */
export function setApiKey(providerId: string, key: string): void {
  const store = load();
  if (key) {
    store[providerId] = key;
  } else {
    delete store[providerId];
  }
  save(store);
}

/** 列出已配置 Key 的 provider id（设置面板展示用） */
export function listConfiguredProviders(): string[] {
  return Object.keys(load());
}
