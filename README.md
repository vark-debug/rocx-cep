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

### 方式 A：文件夹安装（推荐）

从 [Releases](../../releases) 下载 `RocX-CEP_x.y.z.zip`，解压到 CEP 扩展目录：

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

### 方式 B：ZXP 安装

下载 Release 里的 `com.rocx.cep.zxp`，拖进 [ZXP Installer](https://install.zxpinstaller.com/)，
无需改注册表 / PlayerDebugMode。

### 安装可灵 CLI（两种方式都需要）

```bash
npm i -g @klingai/cli-cn
kling login
```

重启 Premiere Pro，菜单 **窗口 → 扩展 → RocX** 打开面板。

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

- v0.1.0 仅支持可灵（Kling）作为生成后端
- 抓视频依赖 `exportAsMediaDirect`，片段越长导出等待越久（PR 界面显示进度条）
- 自定义提示词模板的存储与设置页管理暂未实现（仅内置 5 条）

## License

[MIT](LICENSE)
