; RocX CEP Windows 安装包（Inno Setup）
;
; 设计要点：
;   - PrivilegesRequired=lowest → per-user 安装，全程免管理员
;     （扩展装用户域 %APPDATA%\Adobe\CEP\extensions，Premiere 官方支持）
;   - 内嵌 runtime → %LOCALAPPDATA%\RocX\runtime（对应 cli.ts bundled 探测链）
;   - PlayerDebugMode → HKCU\Software\Adobe\CSXS.{9..13} = "1"（未签名扩展必需，
;     HKCU 不需要管理员）
;   - 未签名 → SmartScreen 首次运行会警告一次，点「仍要运行」即可
;
; 构建（CI 上 choco install innosetup 后）：
;   iscc /DMyAppVersion=<version> packagers/win/rocx.iss
; 签名（预留，未配置则跳过）：
;   iscc /Smysig="signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 $p" ...

#define MyAppName "RocX CEP"
#ifndef MyAppVersion
#define MyAppVersion "0.0.0"
#endif
#define MyAppPublisher "RocX"

[Setup]
AppId={{8C4E1D2F-6A3B-4E5F-9C0D-1A2B3C4D5E6F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 没有本地 exe 要装：所有文件去 CEP 扩展目录与 runtime 目录，
; 这里只是卸载数据的落点，跳过选目录页避免用户困惑
DefaultDirName={userappdata}\RocX\CEP
DisableDirPage=yes
DisableProgramGroupPage=yes
; per-user 免管理员
PrivilegesRequired=lowest
OutputDir=..\..\build\exe
OutputBaseFilename=RocX-CEP_{#MyAppVersion}_win_x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; 向导语言用默认英文（ChineseSimplified.isl 是非官方翻译，CI 环境不带；
; 需要时把 .isl 放到本目录并恢复 [Languages] 段）
; [Languages]
; Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
; 扩展本体（dist/cep 产物）→ 用户域 CEP 扩展目录
Source: "..\..\dist\cep\*"; DestDir: "{userappdata}\Adobe\CEP\extensions\com.rocx.cep"; Flags: ignoreversion recursesubdirs createallsubdirs
; 内嵌 runtime（build-runtime.mjs 产物，win-x64）→ 探测链位置
Source: "..\..\build\runtime\win-x64\*"; DestDir: "{localappdata}\RocX\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
; 未签名扩展必须开 PlayerDebugMode；HKCU 无需管理员
; PR 2021–2024 = CSXS.11，2025/2026 = CSXS.12；9–13 全写，多余的键无副作用
; 故意不加 uninsdeletevalue：卸载 RocX 不应动用户的调试开关
;（用户可能还有其他未签名扩展依赖它）
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: createvalueifdoesntexist

[Run]
Filename: "https://github.com/vark-debug/rocx-cep/releases"; Description: "查看发布说明"; Flags: postinstall skipifsilent unchecked

[UninstallDelete]
; 卸载清掉扩展与 runtime；Inno 自己的卸载数据在 DefaultDirName 里自管理
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.rocx.cep"
Type: filesandordirs; Name: "{localappdata}\RocX\runtime"
