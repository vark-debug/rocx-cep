/**
 * Webhook 上报：生成任务提交成功后把结果推送到外部平台（飞书多维表格 / 钉钉等）
 *
 * 自 UXP 版（RocX/src/core/webhook.ts）移植，两处刻意差异：
 * 1. HTTP 走 CEP 内嵌 Node（https.request）而非 UXP fetch；
 * 2. purpose 细化为 `{provider}_{tool}`（如 kling_text_to_video / kling_image_to_image /
 *    kling_omni_ref_video）—— UXP 版是粗粒度枚举（KLING_VIDEO_GEN 等）。
 *    后续接入新 provider 时只要记录里 params.provider/params.tool 齐全，
 *    purpose 自动跟随，无需改这里。
 *
 * 配置（对齐 UXP「地址与 token 不跨层暴露给 webview」）：
 *   ~/.rocx-cep/config.json
 *   {
 *     "feishuWebhookUrl": "https://...",   // 必填，飞书多维表格自动化入参地址
 *     "feishuToken": "...",                // 可选，Bearer 凭证（强烈建议开，见限流说明）
 *     "editorName": "张三"                 // 可选，上报行「剪辑师」列
 *   }
 * 每次上报都重新读文件 —— 允许运行中修改，无需重启面板。
 *
 * 飞书频率限制（官方）：整个多维表格 50 次/秒；单个自动化流程 5 次/秒；
 * 未开启凭证校验时仅 1 次/秒 → 建议 Bearer token。
 *
 * 上报为 fire-and-forget：限流重试后仍失败、鉴权、网络故障都只 console.warn，
 * 不影响、不阻塞生成主流程。
 */
import { https, http as httpMod, os as osMod, fs as fsMod, path as pathMod } from "../lib/cep/node";
import type { GenerationRecord } from "../../shared/types";

/** 飞书返回的限流错误码：触发频率超出限制 */
const RATE_LIMIT_CODE = 800005652;

/** 限流退避基数（ms），最多重试 3 次；首档 ≈ 单流程 200ms 最小间隔的 2 倍 */
const RETRY_BASE_DELAYS_MS = [400, 800, 1600];

/** 请求超时（ms）—— fire-and-forget 上报不该占用长连接 */
const POST_TIMEOUT_MS = 10000;

// ---------- 配置 ----------

export interface WebhookConfig {
  feishuWebhookUrl: string;
  feishuToken: string;
  editorName: string;
}

/** 配置文件路径：~/.rocx-cep/config.json */
const configPath = (): string =>
  pathMod.join(osMod.homedir(), ".rocx-cep", "config.json");

/** 读配置；文件不存在 / 字段缺失按空串处理（未配置 → 上报 skipped） */
function readConfig(): WebhookConfig {
  const blank: WebhookConfig = {
    feishuWebhookUrl: "",
    feishuToken: "",
    editorName: "",
  };
  try {
    if (!fsMod.existsSync(configPath())) return blank;
    const raw = fsMod.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WebhookConfig>;
    return {
      feishuWebhookUrl:
        typeof parsed.feishuWebhookUrl === "string"
          ? parsed.feishuWebhookUrl.trim()
          : "",
      feishuToken:
        typeof parsed.feishuToken === "string" ? parsed.feishuToken.trim() : "",
      editorName:
        typeof parsed.editorName === "string" ? parsed.editorName.trim() : "",
    };
  } catch (e) {
    console.warn("[webhook] 配置读取失败", e);
    return blank;
  }
}

// ---------- payload ----------

/**
 * purpose：`{provider}_{tool}`。
 *
 * - 记录 params 里 tool 齐全 → 直接拼（kling_text_to_video / kling_image_to_image /
 *   kling_omni_ref_video / kling_image_to_video / kling_text_to_image）
 * - tool 缺失（异常老记录）→ 按 kind 兜底成 `{provider}_image_gen` / `{provider}_video_gen`
 */
export function resolvePurpose(record: GenerationRecord): string {
  const provider = record.params?.provider || "unknown";
  const tool = record.params?.tool;
  if (tool) return `${provider}_${tool}`;
  return record.kind === "image"
    ? `${provider}_image_gen`
    : `${provider}_video_gen`;
}

/** 工程名为空时退回路径末段文件名 */
function resolveProjectName(projectPath?: string): string {
  const seg = (projectPath || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return seg || "";
}

/** 上报 payload（8 字段，与 UXP 版 / 飞书表格列一一对应） */
export interface ReportPayload {
  recordId: string;
  /** 非 CNY 单位恒为 0（CEP 版当前只有可灵，走灵感值列） */
  estimateCost: number;
  /** 可灵的真实扣费灵感值（提交即扣） */
  creditsConsumed: number;
  costUnit: "CNY" | "CREDITS";
  /** 可灵是「提交即上报」→ 恒为 submitted */
  status: string;
  editorName: string;
  projectName: string;
  purpose: string;
}

export function buildReportPayload(
  record: GenerationRecord,
  editorName: string,
): ReportPayload {
  return {
    recordId: record.id,
    estimateCost: 0,
    creditsConsumed:
      typeof record.creditsConsumed === "number" ? record.creditsConsumed : 0,
    costUnit: "CREDITS",
    status: "submitted",
    editorName,
    projectName: resolveProjectName(record.projectPath),
    purpose: resolvePurpose(record),
  };
}

// ---------- HTTP ----------

interface PostResult {
  ok: boolean;
  /** 是否命中限流（决定是否重试） */
  rateLimited: boolean;
  error?: string;
}

function postOnce(
  url: string,
  token: string,
  body: string,
): Promise<PostResult> {
  return new Promise((resolve) => {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let settled = false;
    const done = (r: PostResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    try {
      // http/https 双协议：飞书是 https，本地自测接收器走 http
      const transport = url.startsWith("http://") ? httpMod : https;
      const req = transport.request(
        url,
        { method: "POST", headers, timeout: POST_TIMEOUT_MS },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            // 飞书限流可能是 HTTP 429，也可能是 200 + body.code 表达，两种都算
            let code: number | undefined;
            try {
              const parsed = JSON.parse(text);
              if (parsed && typeof parsed.code === "number") code = parsed.code;
            } catch {
              // 非 JSON 响应体，忽略
            }
            if (res.statusCode === 429 || code === RATE_LIMIT_CODE) {
              done({ ok: false, rateLimited: true });
              return;
            }
            if ((res.statusCode || 500) >= 300) {
              done({
                ok: false,
                rateLimited: false,
                error: `HTTP ${res.statusCode} ${text.slice(0, 200)}`,
              });
              return;
            }
            // HTTP 2xx 但 body.code 非 0：业务侧拒绝（如 token 校验失败），不算限流
            if (code !== undefined && code !== 0) {
              done({
                ok: false,
                rateLimited: false,
                error: `飞书返回错误码 ${code}: ${text.slice(0, 200)}`,
              });
              return;
            }
            done({ ok: true, rateLimited: false });
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`timeout ${POST_TIMEOUT_MS}ms`));
      });
      // 网络异常不重试：大概率断网或地址不可达，退避也救不回来
      req.on("error", (e: Error) =>
        done({ ok: false, rateLimited: false, error: `网络异常: ${e.message}` }),
      );
      req.write(body);
      req.end();
    } catch (e: any) {
      done({ ok: false, rateLimited: false, error: `请求构造失败: ${String(e?.message || e)}` });
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 发送一次并在命中限流时退避重试（±50% 抖动）；鉴权、参数、网络异常不重试 */
async function sendWithRetry(
  url: string,
  token: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  let last: PostResult = { ok: false, rateLimited: false };
  for (let attempt = 0; attempt <= RETRY_BASE_DELAYS_MS.length; attempt++) {
    last = await postOnce(url, token, body);
    if (last.ok || !last.rateLimited) break;
    if (attempt < RETRY_BASE_DELAYS_MS.length) {
      await sleep(RETRY_BASE_DELAYS_MS[attempt] * (0.5 + Math.random()));
    }
  }
  if (last.ok) return { ok: true };
  if (last.rateLimited) {
    return {
      ok: false,
      error: `飞书接口限流，已重试 ${RETRY_BASE_DELAYS_MS.length} 次仍未成功（错误码 ${RATE_LIMIT_CODE}）`,
    };
  }
  return { ok: false, error: last.error };
}

// ---------- 对外入口 ----------

export interface ReportOutcome {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  purpose?: string;
}

/** 设置页「测试上报」用的固定样例，与飞书表格字段一一对应 */
const SAMPLE_PAYLOAD: ReportPayload = {
  recordId: "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  estimateCost: 0,
  creditsConsumed: 35,
  costUnit: "CREDITS",
  status: "submitted",
  editorName: "",
  projectName: "Nike_春季广告片_剪辑版",
  purpose: "kling_text_to_video",
};

/**
 * 测试上报：用固定样例打一次 webhook，验证地址 / 令牌 / 表格字段映射。
 * 沿用真实上报的限流重试逻辑，避免测试路径与生产路径行为不一致。
 */
export async function testReport(): Promise<ReportOutcome> {
  const cfg = readConfig();
  if (!cfg.feishuWebhookUrl) {
    return { ok: false, skipped: true, error: "未配置 Webhook 地址" };
  }
  const payload = { ...SAMPLE_PAYLOAD, editorName: cfg.editorName };
  const res = await sendWithRetry(
    cfg.feishuWebhookUrl,
    cfg.feishuToken,
    JSON.stringify(payload),
  );
  return { ...res, purpose: payload.purpose };
}

/**
 * 把一条记录上报到飞书多维表格（生成提交成功后调用）。
 * 未配置地址时 skipped，不发请求；任何失败只 console.warn —— fire-and-forget。
 */
export async function reportGenerated(
  record: GenerationRecord,
): Promise<ReportOutcome> {
  const cfg = readConfig();
  const purpose = resolvePurpose(record);
  if (!cfg.feishuWebhookUrl) {
    return { ok: false, skipped: true, error: "未配置 Webhook 地址", purpose };
  }
  const payload = buildReportPayload(record, cfg.editorName);
  const res = await sendWithRetry(
    cfg.feishuWebhookUrl,
    cfg.feishuToken,
    JSON.stringify(payload),
  );
  if (!res.ok) {
    // fire-and-forget：失败只留日志，不打扰生成主流程
    console.warn(
      `[webhook] 上报失败 purpose=${purpose} record=${record.id}`,
      res.error,
    );
  }
  return { ...res, purpose };
}
