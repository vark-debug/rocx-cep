# Changelog

## 0.3.0 (2026-10-31)

与 UXP 版对齐：接入三家 HTTP 直连生成服务。

- **provider 体系**（自 RocX UXP 版移植，Node 层化）：
  - MiniMax 视频：`MiniMax-H3`（768P/2K）/ `H3-Max`（480P/768P），4–15s，参考素材上传后以 `mm_file://` 引用
  - RunningHub 图片：Seedream 5.0 Pro 文生图 / 图生图（base64 data URI 直传），1K/2K
  - 火山方舟（Ark）图片：Seedream 5.0 Pro，同步出图；提示词含透明关键词自动走透明底画布
- **面板**：provider 切换器（CEP 原生 select 弹不出来，走自定义浮层）；模型/时长/分辨率/画幅
  按 provider 声明的值域自动收敛；可灵仍走 CLI 链路不受影响
- **API Key 管理**：per-provider 存插件数据目录 `api-keys.json`（0600 权限）；设置面板内配置
- **dry-run 模式**：设置面板开关；开启后提交被拦截，只构造并打印请求（无 Key 也能验证全链），
  记录标注「dry-run 模拟任务」
- webhook 上报 `purpose` 自动跟随真实 provider（`minimax_image_to_video` / `ark_text_to_image` 等）

## 0.2.0 (2026-10-31)

一步到位安装包 + 生成上报。

- **安装包（推荐方式）**：mac 双击 pkg（Apple Silicon / Intel 双架构）、Windows 双击 exe（Inno Setup，per-user 免管理员）。
  内嵌官方 node LTS + 可灵 CLI runtime，装完即用 —— 无需系统 node/npm、无需 `npm i -g`。
  安装脚本自动开启 PlayerDebugMode（实测 CSXS 只读用户域：postinstall 以各用户身份写入；
  Windows 写 HKCU）
- **CLI 来源感知**：面板区分「已内置 / 已安装」；内嵌 runtime 被删或损坏时自动回落系统 node + npm 全局 CLI
- **webhook 生成上报**：任务提交成功后向自配 webhook 推送记录（fire-and-forget），
  `purpose` 精确到具体工具（`kling_text_to_video` / `kling_image_to_image` / `kling_omni_ref_video` 等 `{provider}_{tool}` 格式）；
  飞书限流自动重试（400/800/1600ms ± 抖动）；面板提供「测试上报」按钮
- 安装方式三选一：安装包（推荐）/ zip 文件夹 / zxp

## 0.1.1 (2026-10-31)

Windows / Premiere Pro 2021 兼容性（实测 Win 10 + PR 2021、macOS + PR 2026）。

- **host 层加载**：PR 2021（15.2）Windows 下 `$.evalFile` 报 "Cannot convert" 导致面板
  永远加载不上 —— 改为 Node 读入 jsx 文件内容后整体 `evalScript` 执行，
  并在失败时透出行号（PR 2026 新脚本引擎不受影响）
- **spawn ENOMEM 对策**：CEP 内嵌 Node（旧 libuv）在 Windows 上创建子进程时对继承的
  环境块敏感（`=C:` 隐藏变量 / 环境块超长均被映射为 UV_ENOMEM）——
  spawn 前净化环境块；仍失败则用最小安全环境自动重试一次
- **npm 全局探测**：补齐 Windows 下降级安装（`--prefix ~/.npm-global`）的布局探测；
  修复 `npm err!` 前缀被误判为权限错误导致的无意义降级；
  安装验证失败时透出首次安装的真实错误输出
- **构建脚本**：`check:es3` 用 `fileURLToPath` 修复 Windows 下 `/C:/` 双盘符路径

## 0.1.0 (2026-10-31)

首个 CEP 版本（自 RocX UXP 版移植）。

- 抓帧：播放头当前帧 → PNG 参考图；正确适配「画框 / 时间码」两种时间显示格式
- 抓帧 → PS：抓帧自动拉起 Photoshop，「修改完成」后失效缓存回传
- 抓视频：按序列入出点导出 MP4（`exportAsMediaDirect` 内置导出管线，不依赖 AME）；
  预设存在性预检避免弹导出对话框；host 层错误码化避免中文乱码
- 可灵生成：文生视频 / 图生视频（多图参考）/ 文生图 / 图生图（多图下载导入）
- `/` 提示词模板浮层：内置 5 条模板、`「甲或乙」`/`{xxx}` 锚定符、键盘导航、原样提交拦截
- 首次抓素材自动填生成时长（向上取整到合法档位）与画幅比（最近档匹配）
- 生成记录：轮询、结果落盘、自动导入项目面板、按工程隔离
- toast 提示卡片（3s 停留 + 1s 渐隐）
