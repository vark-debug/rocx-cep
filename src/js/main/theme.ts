/**
 * 宿主主题适配（Panel 层）
 *
 * UXP 版直接用 `--uxp-host-*` CSS 变量，CEP 没有等价物，但
 * `CSInterface.getHostEnvironment()` 会返回宿主皮肤信息：
 *
 *   appSkinInfo.panelBackgroundColor / panelForegroundColor / panelBorderColor
 *   appSkinInfo.panelFontSize / panelFontType
 *
 * 这里把它归一化成一套 CSS 变量（命名对齐 UXP），写到 :root 上，
 * 之后所有样式只认自己这套变量 —— 换主题 / 深浅色都自动跟随 Premiere。
 */
import { csi } from "../lib/utils/bolt";

/** 宿主皮肤信息里用到的字段 */
interface HostSkin {
  appSkinInfo?: {
    panelBackgroundColor?: { color?: Rgb };
    panelForegroundColor?: { color?: Rgb };
    panelBorderColor?: { color?: Rgb };
    panelFontSize?: number;
    panelFontType?: string;
  };
}

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** 面板配色方案 */
export interface PanelTheme {
  /** 面板背景 */
  bg: string;
  /** 主文字色 */
  fg: string;
  /** 次级文字色 */
  fgSecondary: string;
  /** 边框色 */
  border: string;
  /** 强调色（链接 / 主按钮） */
  accent: string;
  /** 面板背景之上的浮层色（卡片 / 输入框） */
  surface: string;
  /** 悬浮态背景 */
  hover: string;
  /** 是否深色主题 */
  dark: boolean;
  /** 字号（px） */
  fontSize: number;
  /** 字体 */
  fontFamily: string;
}

/** 默认深色主题（拿不到宿主信息时的兜底） */
const FALLBACK_DARK: PanelTheme = {
  bg: "#2b2b2b",
  fg: "#ffffff",
  fgSecondary: "#b0b0b0",
  border: "#454545",
  accent: "#4b9cf5",
  surface: "#383838",
  hover: "#3d3d3d",
  dark: true,
  fontSize: 12,
  fontFamily: '"Adobe Clean", "Segoe UI", system-ui, sans-serif',
};

/** 把 0-255 的 RGB 转成 #hex */
function toHex(c: Rgb): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(c.red)}${h(c.green)}${h(c.blue)}`;
}

/** 亮度（0-255），用于判断深浅色 */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 0;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 混合两个 hex 颜色（t=0 取 a，t=1 取 b） */
function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(a);
  const pb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b);
  if (!pa || !pb) return a;
  const out = [1, 2, 3].map((i) => {
    const va = parseInt(pa[i], 16);
    const vb = parseInt(pb[i], 16);
    return Math.round(va + (vb - va) * t)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${out.join("")}`;
}

/** 读取宿主环境 */
function readHostEnv(): HostSkin | null {
  try {
    if (!window.__adobe_cep__) return null;
    return JSON.parse(
      window.__adobe_cep__.getHostEnvironment() as string,
    ) as HostSkin;
  } catch {
    return null;
  }
}

/**
 * 计算当前面板主题。
 *
 * 宿主给了背景色就用宿主的（这样面板和 Premiere 融在一起）；
 * 其余色（前景 / 边框 / 强调色 / 浮层）由背景色明暗推导 —— 深色背景下
 * 前景用亮色、浮层比背景亮一档；浅色背景下反过来。
 */
export function computeTheme(): PanelTheme {
  const env = readHostEnv();
  const skin = env?.appSkinInfo;
  const bgRaw = skin?.panelBackgroundColor?.color;
  const fgRaw = skin?.panelForegroundColor?.color;
  const bdRaw = skin?.panelBorderColor?.color;

  const bg = bgRaw ? toHex(bgRaw) : FALLBACK_DARK.bg;
  const dark = luminance(bg) < 128;

  // 宿主给了前景色就用宿主的，否则按明暗推导
  const fg = fgRaw
    ? toHex(fgRaw)
    : dark
      ? FALLBACK_DARK.fg
      : "#1e1e1e";

  const border = bdRaw
    ? toHex(bdRaw)
    : dark
      ? FALLBACK_DARK.border
      : "#d0d0d0";

  return {
    bg,
    fg,
    fgSecondary: mix(fg, bg, 0.38),
    border,
    accent: dark ? FALLBACK_DARK.accent : "#1a6fd4",
    surface: mix(bg, fg, dark ? 0.12 : 0.06),
    hover: mix(bg, fg, dark ? 0.2 : 0.12),
    dark,
    fontSize: skin?.panelFontSize || FALLBACK_DARK.fontSize,
    fontFamily: skin?.panelFontType
      ? `"${skin.panelFontType}", system-ui, sans-serif`
      : FALLBACK_DARK.fontFamily,
  };
}

/** 把主题写成 CSS 变量（写到 :root） */
export function applyTheme(theme: PanelTheme): void {
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--rp-bg", theme.bg);
  set("--rp-fg", theme.fg);
  set("--rp-fg-secondary", theme.fgSecondary);
  set("--rp-border", theme.border);
  set("--rp-accent", theme.accent);
  set("--rp-surface", theme.surface);
  set("--rp-hover", theme.hover);
  set("--rp-font-size", `${theme.fontSize}px`);
  set("--rp-font-family", theme.fontFamily);
  root.style.setProperty("--rp-dark", theme.dark ? "1" : "0");
}

/**
 * 订阅主题变化。
 *
 * CEP 的 `com.adobe.csxs.events.ThemeColorChanged` 事件在用户切换
 * Premiere 主题（深/浅）时触发 —— 跟着切，面板配色自动跟上。
 */
export function subscribeTheme(callback: (theme: PanelTheme) => void): () => void {
  const notify = () => {
    const theme = computeTheme();
    applyTheme(theme);
    callback(theme);
  };
  notify();
  try {
    csi.addEventListener(
      "com.adobe.csxs.events.ThemeColorChanged",
      notify,
      {},
    );
  } catch {
    // 事件注册失败也不影响一次性主题应用
  }
  return () => {};
}
