#!/usr/bin/env bash
#
# RocX CEP pkg 安装后脚本（以 root 运行）
#
# 扩展未签名 → 必须开启 PlayerDebugMode，否则 Premiere 不加载。
# 写系统域 /Library/Preferences —— postinstall 以 root 跑，
# 直接 `defaults write com.adobe...` 会写进 root 的用户域，普通用户读不到；
# 带路径写文件域则对所有用户生效（CEP 读取顺序：用户域 → 系统域）。
#
# 覆盖 CSXS 9–13：PR 2021–2024 = CSXS.11，2025/2026 = CSXS.12，
# 通行做法全写（旧版本主机上多余的 plist 无副作用）。
set -euo pipefail

for n in 9 10 11 12 13; do
  defaults write "/Library/Preferences/com.adobe.CSXS.$n" PlayerDebugMode 1
done

exit 0
