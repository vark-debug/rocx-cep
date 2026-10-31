/**
 * per-provider API Key 存储（Node 层）
 *
 * 放插件数据目录（getPluginDataDir）的 api-keys.json，与生成记录分离 ——
 * Key 是全局凭据，不应随工程目录走。
 *
 * 加密：AES-256-GCM，密钥由机器指纹派生（scrypt）：
 *   hostname + 用户名 → 本机可解密，文件被拷到其他机器 / 换用户解不开。
 *   防的是「明文凭据躺在磁盘上被备份 / 网盘同步扫走」，不是防本机 root。
 * 文件权限 0600：本地凭据只留给当前用户。
 *
 * 兼容：旧版是明文 JSON（{ providerId: key }），读到后自动迁移为加密格式。
 */
import { fs, path, crypto, os } from "../../lib/cep/node";
import { getPluginDataDir } from "./paths";

/** 加密文件的版本标记（有 v=1 才是密文格式，否则按旧明文迁移） */
const FORMAT_VERSION = 1;

/** scrypt 派生参数（Node 默认 N=16384，成本一次性 ~50ms，结果缓存） */
const SCRYPT_KEYLEN = 32;

/** 密文段格式：iv:authTag:cipher（全 hex） */
interface CipheredKey {
  iv: string;
  tag: string;
  data: string;
}

interface KeyStoreV1 {
  v: number;
  keys: Record<string, string>;
}

/** 旧明文格式 */
interface LegacyKeyStore {
  [providerId: string]: string;
}

let cache: Record<string, string> | null = null;
let derivedKey: Buffer | null = null;

function storePath(): string {
  const dir = getPluginDataDir();
  if (!dir) return "";
  return path.join(dir, "api-keys.json");
}

/**
 * 机器指纹派生密钥（结果缓存）。
 *
 * userInfo 在部分环境会 throw（无 tty 等），逐级降级到 homedir / 常量。
 */
function machineKey(): Buffer {
  if (derivedKey) return derivedKey;
  let fingerprint = "rocx-cep";
  try {
    fingerprint = [os.hostname(), os.userInfo().username || "u", "rocx-cep.v1"]
      .join("|");
  } catch {
    try {
      fingerprint = `${os.hostname()}|rocx-cep.v1`;
    } catch {
      fingerprint = "rocx-cep.v1";
    }
  }
  derivedKey = crypto.scryptSync(fingerprint, "rocx-cep.apikey.salt.v1", SCRYPT_KEYLEN);
  return derivedKey;
}

/** 明文 → 密文段 */
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", machineKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("hex"),
    tag.toString("hex"),
    data.toString("hex"),
  ].join(":");
}

/** 密文段 → 明文；失败（换机器 / 数据损坏）返回空串 */
function decrypt(ciphered: string): string {
  const [ivHex, tagHex, dataHex] = ciphered.split(":");
  if (!ivHex || !tagHex || !dataHex) return "";
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      machineKey(),
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch (e) {
    console.warn("[apiKeys] 解密失败（换机器或数据损坏？）:", e);
    return "";
  }
}

function load(): Record<string, string> {
  if (cache) return cache;
  const file = storePath();
  if (!file) return {};
  let out: Record<string, string> = {};
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (j && typeof j === "object" && j.v === FORMAT_VERSION) {
        // 加密格式：逐条解密成内存里的明文 map
        const keys = (j as KeyStoreV1).keys || {};
        for (const [id, ciphered] of Object.entries(keys)) {
          const plain = decrypt(ciphered);
          if (plain) out[id] = plain;
        }
      } else {
        // 旧明文格式：迁移为加密存储
        const legacy = (j as LegacyKeyStore) || {};
        out = {};
        for (const [id, key] of Object.entries(legacy)) {
          if (typeof key === "string" && key) out[id] = key;
        }
        console.log("[apiKeys] 检测到旧明文存储，迁移为 AES-256-GCM 加密");
        persistLocked(out);
      }
    }
  } catch (e) {
    console.warn("[apiKeys] 读取失败:", e);
    out = {};
  }
  cache = out;
  return cache;
}

/** 写盘（加密 + 0600）；cache 由调用方维护 */
function persistLocked(store: Record<string, string>): void {
  const file = storePath();
  if (!file) return;
  const keys: Record<string, string> = {};
  for (const [id, plain] of Object.entries(store)) {
    keys[id] = encrypt(plain);
  }
  const body: KeyStoreV1 = { v: FORMAT_VERSION, keys };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
}

function save(store: Record<string, string>): void {
  const file = storePath();
  if (!file) return;
  try {
    persistLocked(store);
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
