# RocX UXP → CEP 移植整理：CEP 与 UXP 区别及移植要点

> 目标：将 RocX v0.6.1（Premiere Pro UXP 插件，基于 Bolt UXP）移植为 CEP 版本（基于 Bolt CEP）
> 整理日期：2026-10-30

---

## 一、RocX 现状盘点（先搞清楚要移植什么）

RocX 是 **Premiere Pro 的 AI 生成面板插件**（manifest v6，UXP 8.x，CCX 安装，PR 25.6.4+）：

| 模块 | 依赖的 UXP 能力 |
| --- | --- |
| 视频生成（MiniMax H3）/ 图片生成（RunningHub / 火山方舟 Seedream） | 纯网络请求 + UXP WebView UI（`allowLocalRendering`，UXP 8.0+） |
| 抓帧 | `Exporter.exportSequenceFrame`（PR UXP DOM） |
| 抓视频（依赖 AME） | `EncoderManager.exportSequence`（`QUEUE_TO_AME` + 渲染事件回调） |
| 导入工程 | `Project.importFiles` / `lockedAccess` / `executeTransaction` / `createOverwriteItemAction` |
| 序列信息 / 智能尺寸 | `Sequence.getInPoint/getOutPoint/getVideoTrackCount`、`TickTime` |
| 抓帧 → Photoshop | C++ Hybrid Addon（`native/RocXBridge`）拉起 PS + launcher 回退 |
| 可灵（kling CLI） | C++ Hybrid Addon `runCommand` 调本机 CLI |
| API Key 存储 | `secureStorage`（macOS 钥匙串），降级混淆文件 |
| 飞书多维表格上报 | UXP 端发 webhook（token 不暴露给 WebView） |
| 结果落盘 | UXP PluginData 私有目录 + 项目旁 `AI-Generated-Media/` |
| 拖拽到时间线 | UXP 面板 → PR 时间线拖拽 |

架构特点：**Bolt UXP 的 Webview UI 模式** = UXP 沙箱端（调 PR DOM、发请求）+ WebView 前端（React UI），两端类型安全双向消息桥。

---

## 二、CEP vs UXP 核心区别

| 维度 | CEP（Common Extensibility Platform） | UXP（Unified Extensibility Platform） |
| --- | --- | --- |
| 官方状态 | **Legacy**，Adobe 明确"未来会弃用并移除"，不再推荐新项目 | 现行推荐方案，PS 最成熟；PR 25.6+ 正式支持 |
| 运行时 | 每个扩展一个**独立 Chromium 实例 + 独立进程** | 与宿主**同进程**，共享一个沙箱化 V8 引擎 |
| JS 环境 | 三层：面板 Chromium JS（现代）+ **Node.js**（完整）+ **ExtendScript**（ECMA3，约 2000 年水平） | 单层现代 V8（支持大部分 ES2020+） |
| 与宿主通信 | `CSInterface.evalScript()` **字符串桥**，参数只能传字符串，双向异步 | **直接调用宿主 DOM API**，无桥、无字符串序列化 |
| Manifest | `manifest.xml`（CSXS 结构） | `manifest.json`（v5/v6），声明 `requiredPermissions` |
| 网络权限 | **无限制**（Chromium 直接 fetch） | `network.domains` 白名单，逐域名申请 |
| 文件系统 | Node `fs` 全权限 + 随意读写 | 沙箱权限制（`localFileSystem` + token） |
| 子进程/CLI | Node `child_process` 直接用 | 无 Node，需 **C++ Hybrid Plugin**（PS/PR/ID 支持） |
| UI | 完整 HTML/CSS（Chromium 全量） | UXP HTML 子集 + Spectrum 组件；复杂 UI 走 `WebView` 元素 |
| 打包分发 | ZXP（ZXPSignCMD 签名）/ 手动放目录 + PlayerDebugMode；可绕过市场分发 | CCX（UPIA/CC 桌面安装）；上架 CC Marketplace 需审核 |
| 宿主覆盖 | 全家桶（PS/PR/AE/AI/ID/AME…）历史版本通吃 | PS/PR/ID 等，**AE 面板仅 Beta**；版本门槛高（PR 需 25.6+） |
| Apple Silicon | Photoshop 下 CEP 需 **Rosetta** 模式 | 原生支持 |
| 调试 | Chrome 远程调试（`--remote-debugging-port`）、ExtendScript Toolkit / VS Code 插件 | UXP Developer Tool（UDT）+ VS Code debugger |
| 事件模型 | CSInterface 事件 + ExtendScript 回调受限 | 宿主原生事件（如 EncoderManager 的 `EVENT_RENDER_COMPLETE`） |

来源：Adobe 官方 [UXP for CEP Developers](https://developer.adobe.com/photoshop/uxp/2022/guides/uxp-for-you/uxp-for-cep-devs/)、[CEP to UXP Migration Center](https://developer.adobe.com/uxp/migration-center/)、[Photoshop 插件类型参考](https://helpx.adobe.com/photoshop/desktop/app-integrations/supported-plugins-and-extensions.html)。

**为什么要反向移植（UXP → CEP）？** 合理动机通常是：兼容更老版本的 PR（CEP 支持 10.x ~ 26.x 全系，而 UXP for PR 要 25.6+）、CEP 无网络白名单限制、需要完整 Node.js、CEP 分发更自由（可绕过市场）。

---

## 三、移植映射表（RocX 逐模块）

### 3.1 直接利好（CEP 更简单的部分）

| RocX 的 UXP 做法 | CEP 方案 | 说明 |
| --- | --- | --- |
| WebView UI（UXP WebView 元素 + allowLocalRendering） | **CEP 面板本身就是 Chromium** | 前端 React 代码基本原样搬；还省掉 webview↔uxp 消息桥，Bolt CEP 的 HMR 直接作用在面板上 |
| manifest `network.domains` 白名单 | 删除，CEP 无网络限制 | 飞书通配域名、`*.myqcloud.com` 等全部不用维护 |
| C++ Hybrid Addon（拉起 PS、kling CLI） | **Node.js `child_process`** | 这是最大的架构简化——CEP 面板有完整 Node.js，native addon 整个可以删掉，`npm run native:build` 编译链也省了 |
| `secureStorage` | Node `fs` 存配置（沿用现有混淆降级方案即可） | 或用 keytar 类方案上系统钥匙串 |
| UXP PluginData 私有目录 | Node `fs` + CEP 用户数据目录（`csInterface.getSystemPath` 推导） | 逻辑等价重写 |
| 飞书 webhook 上报 | Node `fetch`/`https` 直接发 | 无白名单，重试逻辑原样保留 |

### 3.2 核心重写区（工作量所在）：Premiere 交互层 UXP DOM → ExtendScript

| UXP API（RocX 在用） | CEP/ExtendScript 对应 | 难度 / 注意点 |
| --- | --- | --- |
| `Project.getActiveProject` / `getActiveSequence` | `app.project` / `app.project.activeSequence` | 简单，注意 activeSequence 可能为 null |
| `Project.importFiles` | `app.project.importFiles([paths], suppressUI, targetBin, importAsNumberedStills)` | 简单，同名 API 历史悠久；返回值处理方式不同（无事务对象，需手动定位导入节点） |
| `lockedAccess` + `executeTransaction` + `compoundAction` + `createOverwriteItemAction` | **无对应概念，直接顺序调用** | CEP 无事务模型；"导入后拿到 projectItem"需按名称/时间轮询项目面板定位 |
| `Sequence.getInPoint/getOutPoint/getVideoTrackCount` | `seq.inPoint` / `seq.outPoint` / `seq.videoTracks.numTracks`（字符串时码） | 简单；ExtendScript 时码是字符串（`ticks`），换算逻辑重写 |
| `TickTime.createWithSeconds` | ticks 字符串换算（254016000000 ticks/秒） | 中等，写个工具函数 |
| `Exporter.exportSequenceFrame`（抓帧） | `seq.exportFramePNG(time, path)` 或 qe DOM 导帧 | 中等；参数是时码字符串，输出格式 PNG；确认目标 PR 版本行为一致 |
| `EncoderManager.exportSequence`（QUEUE_TO_AME + 事件回调） | `app.encoder.encodeSequence(seq, filePath, presetPath)` | **难点①**：ExtendScript 的 app.encoder **无进度/完成事件回调**，需轮询输出文件出现/大小稳定，或改 AME watch folder 流程；编码预设（epr）文件需随包分发 |
| 拖拽卡片到时间线 | **无原生支持** | **难点②**：CEP 面板 → PR 时间线拖拽是知名硬伤；降级方案：导入到项目面板（保留）+ 双击卡片自动插入（`seq.videoTracks[i].insertClip`），或引导手动拖 |
| 抓帧 → Photoshop（Hybrid 拉起 + 文件监视） | Node `child_process.spawn` 拉起 PS 打开文件 + fs.watch 轮询"修改完成" | 简单-中等；比 Hybrid 简单得多；macOS 用 `open -a`、Windows 用 `start` |
| kling CLI 调用（Hybrid `runCommand`） | Node `child_process.exec` | 简单；README 提到 PR 26.2+ 才能加载 Hybrid addon 的限制在 CEP 下**自然消失**，所有 PR 版本都能用 CLI |

### 3.3 打包与调试

| UXP（现状） | CEP（目标） |
| --- | --- |
| CCX 包（manifest v6），双击安装 / UDT 加载 | ZXP（ZXPSignCMD 签名）或直接放 `CEP/extensions` 目录 + `PlayerDebugMode=1`；Bolt CEP 自带 `npm run package` / `build:zxp` |
| UDT 调试 | Chrome 远程调试 + Bolt CEP HMR |
| PR 25.6.4+ 版本门槛 | 覆盖历史版本（CEP 11/12 对应较新 PR，老 PR 用 CEP 9/10，按 `CSXS` 依赖版本声明） |

---

## 四、Bolt CEP vs Bolt UXP（框架层差异）

两者出自同一团队（Hyper Brew），共享工程理念：Vite + TypeScript + React/Vue/Svelte、HMR 热重载、优化构建体积、GitHub Actions 发布流水线。差异在**运行目标与分层**：

| | Bolt UXP（RocX 现用） | Bolt CEP（移植目标） |
| --- | --- | --- |
| 配置文件 | `uxp.config.ts` → 生成 manifest.json (v6) | `cep.config.ts` → 生成 manifest.xml (CSXS) + `.debug` |
| 产物 | CCX / ZIP（sidecar） | ZXP / ZIP（ZXPSignCMD） |
| 后端层 | UXP 沙箱 JS（调 UXP DOM，受权限约束） | **两层**：Node 层（面板内 require）+ ExtendScript 层（`host/*.jsx`，evalScript 调用） |
| UI 层 | UXP HTML / WebView 模式 | 面板 = Chromium 页面（等价于 RocX 的 WebView 层） |
| 桥 | webview ↔ uxp 类型安全双向消息 | panel ↔ host 的类型化 evalScript 封装（Bolt 生成 `.d.ts`） |
| Hybrid | C++ addon（uxp-hybrid-sdk） | 不需要（Node 即可），也可挂 native module |

**移植时的代码分流原则**：把 RocX 的 UXP 沙箱端代码按依赖切成两半——
1. 不碰 PR DOM 的（网络请求、provider 逻辑、飞书上报、文件管理、估价）→ 搬进 Bolt CEP 的 **Node 层**（几乎原样，把 `fs`/`storage` 换成 Node API）
2. 碰 PR DOM 的（导入、抓帧、抓视频、序列信息）→ 用 **ExtendScript 重写**进 `host/` 层，通过 evalScript 暴露给面板

---

## 五、风险与工作量清单

**高风险（可能改变功能范围）**
1. **AME 抓视频无事件回调**：`app.encoder.encodeSequence` 是 fire-and-forget，`EVENT_RENDER_COMPLETE/ERROR/PROGRESS` 这类事件在 CEP 下拿不到 → 需轮询输出文件（出现 + 大小稳定）判定完成；错误场景只能超时兜底
2. **拖拽时间线降级**：CEP 原生不支持面板→时间线拖拽，交互需重新设计（自动插入或引导手动）
3. **导入后定位 projectItem**：无事务对象返回，靠名称轮询项目面板；并发导入时需加锁防错位

**中风险**
4. ExtendScript 是 ECMA3：无 let/const/箭头函数/异步，RocX 的 PR 交互逻辑要"降级重写"，建议保持 jsx 薄、逻辑放 Node 层
5. 时码换算：UXP TickTime 对象 → ticks 字符串，注意 `exportFramePNG` 与入点/出点传参格式
6. 双平台路径差异（Win/mac）在 Node 层用 `path`/`os` 处理，比 Hybrid 时代简单

**低风险 / 利好**
7. 前端 React 代码高比例复用；消息桥换 evalScript 封装
8. C++ Hybrid 整条编译链删除，CI 变简单
9. 网络白名单、secureStorage 降级链等 UXP 特有补丁全部删除
10. 版本兼容面扩大（这是移植的核心收益）：老版本 PR 用户可用

---

## 六、建议落地步骤（Bolt CEP）

1. `bolt-cep` 脚手架新建 Premiere 目标项目（React + TS，`cep.config.ts` 配 host: PPRO）
2. 前端：搬 RocX WebView 前端 → Bolt CEP panel 入口；`webview↔uxp` 消息桥替换为 Bolt CEP 的类型化 `requestHost`/evalScript 桥
3. Node 层：迁移 provider（MiniMax/RunningHub/火山方舟）逻辑 + 飞书上报 + 文件管理 + PS 拉起 + kling CLI
4. ExtendScript 层：实现 `getSequenceInfo / importFiles / exportFrame / encodeSequence` 四个入口（薄 jsx）
5. 抓视频：主路径 `app.encoder.encodeSequence`（epr 预设随包分发，输出文件轮询 + 超时兜底）；按 3.4 方案 B 引入 ffmpeg sidecar 后可拿实时进度，并支持"切片导出"能力
5.5 （升级）片段预览：`<video>` + in/out ticks 播放窗口控制，本地文件走 `--allow-file-access-from-files` 或 Node 层 127.0.0.1 HTTP 流
6. 打包：`npm run package` 出 ZXP，PlayerDebugMode 本地调试，ZXPSignCMD 自签
7. 回归验证矩阵：PR 25.x（CEP 11）/ 26.x（CEP 12）× Win/macOS

---

## 参考来源

- Adobe 官方：UXP for CEP Developers、CEP to UXP Migration Center（反向映射同样适用）
- Adobe 官方博客：Building Plugins Faster with Bolt UXP and Bolt Express（2026-08）
- Hyper Brew：Bolt CEP / Bolt UXP 官网与 npm（bolt-uxp 1.3.25，MIT）
- RocX README（vark-debug/RocX，v0.6.1）：模块与 API 清单的唯一事实来源
