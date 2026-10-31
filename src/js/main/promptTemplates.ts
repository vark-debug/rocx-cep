/**
 * 提示词模板（输入 "/" 唤起）—— 自 RocX（UXP 版）移植
 *
 * - 内置模板：常量，随版本发布（UXP 版的自定义模板管理走 settings
 *   + 设置页，v0.1.0 面板暂未做模板管理，只上内置清单）
 * - 两种锚定符仅在模板内有效，插入时解析、不进入最终提示词：
 *   「甲或乙」→ 按生成模式二选一；{xxx} → 光标锚点，xxx 作为预填文本全选
 * - 提交闸门：模板原样未改就发送时拦截提醒
 */

export interface PromptTemplate {
  id: string;
  /** 浮层里显示的短名（也用于关键词过滤） */
  label: string;
  /** 模板正文（可含锚定符） */
  template: string;
  /** 适用模式：both = 视频/图片通用 */
  scope: "both" | "video" | "image";
}

/** 内置模板（只读，与 UXP 版同款） */
export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "builtin-remove-object",
    label: "移除物品",
    template: "请移除「视频或图片」中的{某个物品}",
    scope: "both",
  },
  {
    id: "builtin-replace-style",
    label: "替换风格",
    template: "保持「视频或图片」主体与构图不变，将整体风格替换为{风格描述}",
    scope: "both",
  },
  {
    id: "builtin-lighting",
    label: "环境光",
    template: "{黄昏}黄金时刻自然光，柔和阴影，电影感色调",
    scope: "both",
  },
  {
    id: "builtin-push-in",
    label: "镜头推近",
    template: "相机缓慢推近主体，浅景深，画面稳定，突出{主体}",
    scope: "video",
  },
  {
    id: "builtin-closeup",
    label: "特写镜头",
    template: "「视频或图片」主体特写，背景虚化，突出{主体细节}",
    scope: "both",
  },
];

/**
 * 按模式 + 关键词过滤模板。
 * query 匹配 label 或 template 正文（大小写不敏感的包含关系）。
 */
export function filterTemplates(
  mode: "video" | "image",
  query: string,
): PromptTemplate[] {
  const q = query.trim().toLowerCase();
  return BUILTIN_TEMPLATES.filter((t) => {
    if (t.scope !== "both" && t.scope !== mode) return false;
    if (!q) return true;
    return (
      t.label.toLowerCase().includes(q) ||
      t.template.toLowerCase().includes(q)
    );
  });
}

/**
 * 解析模板锚定符，返回插入文本与光标区间（相对插入文本的偏移）。
 * - 「甲或乙」：视频取甲、图片取乙（无「或」时保留原文）
 * - {xxx}：去掉花括号，xxx 保留为预填文本 → cursorStart..cursorEnd 全选
 * - 无锚点：光标落在插入文本末尾
 */
export function resolveTemplate(
  tpl: string,
  mode: "video" | "image",
): { text: string; cursorStart: number; cursorEnd: number } {
  let out = "";
  let cursorStart = -1;
  let cursorEnd = -1;
  let i = 0;
  while (i < tpl.length) {
    const ch = tpl[i];
    if (ch === "「") {
      const close = tpl.indexOf("」", i + 1);
      if (close === -1) {
        out += ch;
        i++;
        continue;
      }
      const inner = tpl.slice(i + 1, close);
      const parts = inner.split("或");
      out += mode === "video" ? parts[0] : parts[1] ?? parts[0];
      i = close + 1;
    } else if (ch === "{") {
      const close = tpl.indexOf("}", i + 1);
      if (close === -1) {
        out += ch;
        i++;
        continue;
      }
      const inner = tpl.slice(i + 1, close);
      cursorStart = out.length;
      out += inner;
      cursorEnd = out.length;
      i = close + 1;
    } else {
      out += ch;
      i++;
    }
  }
  if (cursorStart === -1) cursorStart = cursorEnd = out.length;
  return { text: out, cursorStart, cursorEnd };
}

/**
 * 模板闸门：提示词与某模板（按模式解析后，忽略首尾空白）完全一致时返回命中信息，
 * 用于提交前拦截"模板原样未改就发送"的情况。
 * anchor 取模板第一个 {xxx} 的内容（提示用户修改哪里）；无锚点时为空串。
 */
export function matchTemplateGate(
  prompt: string,
  mode: "video" | "image",
): { label: string; anchor: string } | null {
  const p = prompt.trim();
  if (!p) return null;
  for (const t of BUILTIN_TEMPLATES) {
    if (t.scope !== "both" && t.scope !== mode) continue;
    if (resolveTemplate(t.template, mode).text.trim() === p) {
      const m = t.template.match(/\{([^}]*)\}/);
      return { label: t.label, anchor: m ? m[1] : "" };
    }
  }
  return null;
}
