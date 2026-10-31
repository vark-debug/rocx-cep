import { defineConfig, Plugin } from "vite";

import react from "@vitejs/plugin-react"; 

import { cep, CepOptions, runAction } from "vite-cep-plugin";
import cepConfig from "./cep.config";
import path from "path";
import { extendscriptConfig } from "./vite.es.config";

const extensions = [".js", ".ts", ".tsx"];

const devDist = "dist";
const cepDist = "cep";

const src = path.resolve(__dirname, "src");
const root = path.resolve(src, "js");
const outDir = path.resolve(__dirname, "dist", cepDist);

const debugReact = process.env.DEBUG_REACT === "true";
const isProduction = process.env.NODE_ENV === "production";
const isMetaPackage = process.env.ZIP_PACKAGE === "true";
const isPackage = process.env.ZXP_PACKAGE === "true" || isMetaPackage;
const isServe = process.env.SERVE_PANEL === "true";
const action = process.env.BOLT_ACTION;

let input: { [key: string]: string } = {};
cepConfig.panels.map((panel) => {
  input[panel.name] = path.resolve(root, panel.mainPath);
});

const config: CepOptions = {
  cepConfig,
  isProduction,
  isPackage,
  isMetaPackage,
  isServe,
  debugReact,
  dir: `${__dirname}/${devDist}`,
  cepDist: cepDist,
  zxpOutput: `${__dirname}/${devDist}/zxp/${cepConfig.id}`,
  zipOutput: `${__dirname}/${devDist}/zip/${cepConfig.displayName}_${cepConfig.version}`,
  packages: cepConfig.installModules || [],
};

if (action) runAction(config, action);

/**
 * 给 manifest 注入 DebugPort
 *
 * Adobe 的 CEP 调试流程要求 manifest 根节点带 DebugPort：
 * 配合 `defaults write com.adobe.CSXS.12 PlayerDebugMode 1`，
 * 宿主的「调试」菜单才会把这个扩展的远程调试端口暴露出来，
 * 浏览器打开 http://localhost:<DebugPort> 即可连上面板的 DevTools。
 *
 * Bolt 的 manifest 模板不生成该属性，所以在这里补；
 * 端口与 `.debug` 文件里的 Port 保持一致（都取 startingDebugPort）。
 * 打包（ZXP/ZIP）时不注入 —— 正式发布不该暴露调试端口。
 */
const manifestDebugPort = (): Plugin => ({
  name: "rocx-manifest-debug-port",
  enforce: "post",
  generateBundle(_options, bundle) {
    const asset = bundle["CSXS/manifest.xml"];
    if (!asset || asset.type !== "asset") return;
    const source = String(asset.source);
    if (source.includes("DebugPort=")) return;
    asset.source = source.replace(
      /<ExtensionManifest\b/,
      `<ExtensionManifest\n    DebugPort="${cepConfig.startingDebugPort}"`,
    );
  },
});

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cep(config),
    ...(isPackage ? [] : [manifestDebugPort()]),
  ],
  resolve: {
    alias: [{ find: "@esTypes", replacement: path.resolve(__dirname, "src") }],
  },
  root,
  // root 指向 src/js，publicDir 必须显式指回项目根，
  // 否则扩展打包资源（public/epr/*.epr 导出预设）不会进产物
  publicDir: path.resolve(__dirname, "public"),
  clearScreen: false,
  server: {
    port: cepConfig.port,
  },
  preview: {
    port: cepConfig.servePort,
  },

  build: {
    sourcemap: isPackage ? cepConfig.zxp.sourceMap : cepConfig.build?.sourceMap,
    watch: {
      include: "src/jsx/**",
    },
    // commonjsOptions: {
    //   transformMixedEsModules: true,
    // },
    rollupOptions: {
      input,
      output: {
        manualChunks: {},
        // esModule: false,
        preserveModules: false,
        format: "cjs",
        entryFileNames: "assets/[name]-[hash].cjs",
        chunkFileNames: "assets/[name]-[hash].cjs",
      },
    },
    target: "chrome74",
    outDir,
  },
});

// rollup es3 build
const outPathExtendscript = path.join("dist", cepDist, "jsx", "index.js");
extendscriptConfig(
  `src/jsx/index.ts`,
  outPathExtendscript,
  cepConfig,
  extensions,
  isProduction,
  isPackage,
);
