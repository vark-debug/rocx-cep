# RocX CEP

Premiere Pro CEP 面板：在 PR 内直接完成 **参考素材抓取 → 可灵 AI 生成 → 结果回导** 的闭环。
由 [RocX（UXP 版）](https://github.com/) 移植到 CEP 架构，支持 Windows / macOS。

## 功能

- **抓帧**：把播放头当前帧导出为 PNG 参考图（正确处理画框/时间码两种时间显示格式）
- **抓帧 → PS**：抓帧后自动拉起 Photoshop 修改，改完点「修改完成」回传
- **抓视频**：按序列入出点（I/O）导出 MP4 参考视频 —— 走 Premiere 内置导出管线，**不依赖 Media Encoder**
- **AI 生成**：可灵文生视频 / 图生视频 / 文生图 / 图生图，多图参考支持
- **提示词模板**：输入 `/` 唤起模板浮层，`「视频或图片」`、`{预填文本}` 锚定符，原样未改提交会被拦截
- **智能填参**：首次抓取素材时自动填写生成时长（向上取整到合法档位）与画幅比（匹配最近档）
- **生成记录**：任务轮询、结果落盘、自动导入项目面板、按工程隔离

## 安装（用户）

### 方式 A：安装包（推荐）

从 [Releases](../../releases) 下载对应平台的安装包双击安装：

| 平台 | 文件 | 装到哪里 |
| --- | --- | --- |
| macOS (Apple Silicon) | `RocX-CEP_x.y.z_mac_arm64.pkg` | 扩展 → `/Library/Application Support/Adobe/CEP/extensions/`，runtime → `/Library/Application Support/RocX/runtime` |
| macOS (Intel) | `RocX-CEP_x.y.z_mac_x64.pkg` | 同上 |
| Windows x64 | `RocX-CEP_x.y.z_win_x64.exe` | 扩展 → `%APPDATA%\Adobe\CEP\extensions\`，runtime → `%LOCALAPPDATA%\RocX\runtime` |

安装包**已内嵌 node + 可灵 CLI runtime**，装完即用，无需自己装 npm/CLI；
安装脚本自动开启 PlayerDebugMode（macOS 写 `/Library/Preferences`，Windows 写 `HKCU`，均免手动）。

注意事项：

- macOS 未签名安装包：右键 → 打开（首次）；Windows exe：SmartScreen 首次警告点「仍要运行」
- 登录：面板设置里点「登录」会直接拉起可灵 OAuth 授权

### 方式 B：文件夹安装（zip）

下载 `RocX-CEP_x.y.z.zip`，解压到 CEP 扩展目录：

| 平台 | 目录 |
| --- | --- |
| Windows | `C:\Users\<用户名>\AppData\Roaming\Adobe\CEP\extensions\` |
| macOS | `~/Library/Application Support/Adobe/CEP/extensions/` |

解压后应得到 `extensions/com.rocx.cep/` 目录。

再开启 PlayerDebugMode（未签名扩展需要）：

- **Windows**（PowerShell）：

  ```powershell
  reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1
  reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1
  ```

- **macOS**：

  ```bash
  defaults write com.adobe.CSXS.11 PlayerDebugMode 1
  defaults write com.adobe.CSXS.12 PlayerDebugMode 1
  ```

### 方式 C：ZXP 安装

下载 Release 里的 `com.rocx.cep.zxp`，拖进 [ZXP Installer](https://install.zxpinstaller.com/)，
无需改注册表 / PlayerDebugMode。

### 可灵 CLI（方式 B / C 需要）

方式 A 已内置 runtime，跳过本节。其余安装方式需要系统 node ≥ 18 + 全局 CLI：

```bash
npm i -g @klingai/cli-cn
kling login
```

重启 Premiere Pro，菜单 **窗口 → 扩展 → RocX** 打开面板。

## Webhook 上报（可选）

每次生成任务**提交成功**后，把一条记录推送到外部平台（飞书多维表格自动化 / 钉钉等）。fire-and-forget：失败不影响生成。

配置文件 `~/.rocx-cep/config.json`（地址与令牌不经过面板，不落生成记录）：

```json
{
  "feishuWebhookUrl": "https://automation.feishu.cn/...",
  "feishuToken": "可选，Bearer 凭证（强烈建议开启：飞书单流程无凭证限 1 次/秒）",
  "editorName": "张三"
}
```

payload 字段与飞书表格列一一对应：

| 字段 | 说明 |
| --- | --- |
| `recordId` | 生成记录 id |
| `creditsConsumed` | 可灵真实扣费灵感值（提交即扣） |
| `costUnit` | 恒为 `CREDITS` |
| `estimateCost` | 恒为 0（预留人民币口径） |
| `status` | 恒为 `submitted`（提交即上报） |
| `editorName` / `projectName` | 配置的剪辑师名 / PR 工程文件名 |
| `purpose` | `{provider}_{tool}`，见下 |

`purpose` 取值随生成方式自动变化：`kling_text_to_video`、`kling_image_to_video`、`kling_omni_ref_video`（视频参考生成）、`kling_text_to_image`、`kling_image_to_image`。后续接入新 provider 时按同样规则生成（如 `xxx_text_to_image`）。

面板「⚡ 测试上报」按钮会用固定样例打一次 webhook，用于验证地址 / 令牌 / 表格字段映射。

## 开发

```bash
npm install

npm run dev        # 开发模式（HMR）
npm run watch      # 监听构建（面板 + host 层）
npm run zip        # 打 ZIP 安装包 → dist/zip/
npm run zxp        # 打 ZXP（需签名证书配置）
npm run serve      # 面板浏览器预览（脱离 PR 调 UI）
```

`npm run symlink` 可把扩展目录软链到工程 dist，PR 里改完即时生效。

### 架构与红线

```
src/jsx/   host 层（ExtendScript / ES3 —— 无 let/const/箭头函数，无原生 JSON，
           不做网络与业务逻辑；错误信息只能回 ASCII 错误码，中文由 Node 层映射）
src/js/    Node 层 + Panel（React 19 + Vite；Node 层走 fs/子进程，禁止直接碰 PR DOM）
```

详见 [docs/CEP-AI开发提示词.md](docs/CEP-AI开发提示词.md) 与 [docs/RocX-UXP到CEP-移植整理.md](docs/RocX-UXP到CEP-移植整理.md)。

## 已知限制

- 仅支持可灵（Kling）作为生成后端
- 抓视频依赖 `exportAsMediaDirect`，片段越长导出等待越久（PR 界面显示进度条）
- 自定义提示词模板的存储与设置页管理暂未实现（仅内置 5 条）
- 兼容性：实测 PR 2021（Windows）与 PR 2026（macOS）；更低版本未测

## License

[MIT](LICENSE)
