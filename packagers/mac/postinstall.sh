#!/usr/bin/env bash
#
# RocX CEP pkg 安装后脚本（以 root 运行）
#
# 扩展未签名 → 必须开启 PlayerDebugMode，否则 Premiere 不加载。
#
# ⚠ 实测结论（2026-10，PR 2026 / CEP 12）：CSXS 只读**用户域**
#   ~/Library/Preferences/com.adobe.CSXS.<n>.plist ——
#   往 /Library/Preferences（系统域）写虽然文件落盘、defaults read 也能读到，
#   但 CSXS 不认，面板「菜单可见但无法启动」。
#   所以这里枚举真实用户，以各用户身份写用户域。
#
# 覆盖 CSXS 9–13：PR 2021–2024 = CSXS.11，2025/2026 = CSXS.12，
# 通行做法全写（多余的 plist 无副作用）。
set -euo pipefail

for d in /Users/*; do
  u="$(basename "$d")"
  case "$u" in
    Shared | Guest) continue ;;
  esac
  uid="$(id -u "$u" 2>/dev/null)" || continue
  [ "$uid" -ge 500 ] || continue
  for n in 9 10 11 12 13; do
    launchctl asuser "$uid" sudo -u "$u" \
      defaults write com.adobe.CSXS."$n" PlayerDebugMode 1 2>/dev/null || true
  done
done

exit 0
