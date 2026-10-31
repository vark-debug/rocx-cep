#!/usr/bin/env bash
#
# RocX CEP mac 安装包构建（pkgbuild，macOS 自带）
#
# 产物：双击安装 pkg
#   - 扩展 → /Library/Application Support/Adobe/CEP/extensions/com.rocx.cep
#   - 内嵌 runtime（可选）→ /Library/Application Support/RocX/runtime
#   - postinstall → 开 PlayerDebugMode（未签名扩展必需）
#
# 用法：
#   packagers/mac/build-pkg.sh                    # 不带 runtime（用户自行装 CLI）
#   packagers/mac/build-pkg.sh --runtime <dir>    # 内嵌 runtime（build-runtime.mjs 产物）
#   SIGN_IDENTITY="Developer ID Installer: ..." packagers/mac/build-pkg.sh   # 签名
#
# 前置：npm run build 已产出 dist/cep。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
IDENTIFIER="com.rocx.cep"

# 架构代号归一（uname -m 的 x86_64 → x64，与 build-runtime.mjs 的代号一致）
normalize_arch() {
  case "$1" in
    arm64 | aarch64) echo "arm64" ;;
    x86_64 | amd64) echo "x64" ;;
    *) echo "$1" ;;
  esac
}
ARCH_CODE="$(normalize_arch "$(uname -m)")"

EXT_SRC="$ROOT/dist/cep"
RUNTIME_DIR="$ROOT/build/runtime/darwin-$ARCH_CODE"
OUT_DIR="$ROOT/build/pkg"

# ---- 参数解析 ----
RUNTIME_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)
      RUNTIME_OVERRIDE="$2"
      shift 2
      ;;
    --runtime=*)
      RUNTIME_OVERRIDE="${1#*=}"
      shift
      ;;
    --arch)
      ARCH_CODE="$(normalize_arch "$2")"
      RUNTIME_DIR="$ROOT/build/runtime/darwin-$ARCH_CODE"
      shift 2
      ;;
    --arch=*)
      ARCH_CODE="$(normalize_arch "${1#*=}")"
      RUNTIME_DIR="$ROOT/build/runtime/darwin-$ARCH_CODE"
      shift
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done
[[ -n "$RUNTIME_OVERRIDE" ]] && RUNTIME_DIR="$RUNTIME_OVERRIDE"

# ---- 前置检查 ----
if [[ ! -d "$EXT_SRC" ]]; then
  echo "错误: 未找到 $EXT_SRC —— 先执行 npm run build" >&2
  exit 1
fi
WITH_RUNTIME=0
if [[ -d "${RUNTIME_DIR}" && -x "${RUNTIME_DIR}/bin/node" ]]; then
  WITH_RUNTIME=1
  echo "内嵌 runtime: ${RUNTIME_DIR} ($(du -sh "${RUNTIME_DIR}" | cut -f1))"
else
  echo "未找到可用 runtime（${RUNTIME_DIR}），打不含 runtime 的纯插件包"
fi

# ---- staging（--install-location / 的绝对路径结构）----
STAGING="$(mktemp -d "$TMPDIR/rocx-pkg.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

EXT_DST="$STAGING/Library/Application Support/Adobe/CEP/extensions/com.rocx.cep"
mkdir -p "$EXT_DST"
cp -R "$EXT_SRC/." "$EXT_DST/"

if [[ "$WITH_RUNTIME" == 1 ]]; then
  RT_DST="$STAGING/Library/Application Support/RocX/runtime"
  mkdir -p "$RT_DST"
  cp -R "$RUNTIME_DIR/." "$RT_DST/"
fi

# ---- pkg scripts ----
SCRIPTS="$(mktemp -d "$TMPDIR/rocx-pkg-scripts.XXXXXX")"
trap 'rm -rf "$STAGING" "$SCRIPTS"' EXIT
cp "$ROOT/packagers/mac/postinstall.sh" "$SCRIPTS/postinstall"
chmod +x "$SCRIPTS/postinstall"

# ---- pkgbuild ----
# --ownership recommended: payload 统一 root:wheel，无需 sudo
OUT="$OUT_DIR/RocX-CEP_${VERSION}_mac_${ARCH_CODE}.pkg"
mkdir -p "$OUT_DIR"
SIGN_ARGS=()
if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  SIGN_ARGS=(--sign "$SIGN_IDENTITY")
  echo "签名: $SIGN_IDENTITY"
fi
# macOS 自带 bash 3.2 在 set -u 下展开空数组报 unbound variable
SIGN_EXPANDED=()
if [[ ${#SIGN_ARGS[@]} -gt 0 ]]; then
  SIGN_EXPANDED=("${SIGN_ARGS[@]}")
fi

pkgbuild \
  --root "$STAGING" \
  --scripts "$SCRIPTS" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location / \
  ${SIGN_EXPANDED[@]+"${SIGN_EXPANDED[@]}"} \
  "$OUT"

echo "产物: $OUT ($(du -sh "$OUT" | cut -f1))"
