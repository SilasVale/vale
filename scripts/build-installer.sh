#!/usr/bin/env bash
# Vale Windows 在线安装包构建脚本 — Linux 上产出 setup.exe。
#
#   ./scripts/build-installer.sh <1.2.N>
#
# 产物: index/public/vale-agent/ValeAgent-Setup-<ver>.exe (+ ValeAgent-Setup.exe 别名)
# 之后随 index worker 一起 deploy 到 CDN。
#
# 工具链：NSIS 3.12 从源码编译（userspace，无需 sudo；apt 只做 download +
# dpkg-deb -x，gcc10-root 同款手法）。首次运行约 10 分钟（含下载），
# 之后复用 $HOME/nsis-dist 的 makensis，秒级。
# 注意：不要 apt 装 nsis（focal 只有 3.05，缺 3.11/3.12 的提权修复）。
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?usage: ./scripts/build-installer.sh <1.2.N>}"
case "$VER" in -*) echo "::error::usage: ./scripts/build-installer.sh <1.2.N>" >&2; exit 1;; esac
CDN_BASE="${VALE_CDN_BASE:-https://agent.saisi.online}"

NSIS_ROOT="$HOME/nsis-root"
NSIS_SRC_DIR="$HOME/nsis-src/nsis-3.12-src"
NSIS_DIST="$HOME/nsis-dist"
MAKENSIS="$NSIS_DIST/bin/makensis"

cf_token() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then echo "$CLOUDFLARE_API_TOKEN";
  elif [[ -f "$HOME/.cloudflare-token" ]]; then cat "$HOME/.cloudflare-token";
  else echo ""; fi
}

need_toolchain() {
  [[ -x "$MAKENSIS" ]] || return 0
  "$MAKENSIS" -VERSION 2>/dev/null | grep -q "v3.12" || return 0
  return 1
}

build_toolchain() {
  echo "== NSIS 3.12 toolchain bootstrap =="
  mkdir -p "$NSIS_ROOT" "$HOME/nsis-src"
  local tmp; tmp="$(mktemp -d)"
  ( cd "$tmp" && timeout 280 apt-get download mingw-w64 binutils-mingw-w64-x86-64 binutils-mingw-w64-i686 gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 gcc-mingw-w64-i686 g++-mingw-w64-i686 mingw-w64-x86-64-dev mingw-w64-i686-dev mingw-w64-common libz-mingw-w64-dev scons )
  for d in "$tmp"/*.deb; do dpkg-deb -x "$d" "$NSIS_ROOT"; done
  # Debian alternatives 生成的无后缀驱动名在 userspace 下不存在，补软链。
  mkdir -p "$NSIS_ROOT/bin"
  ( cd "$NSIS_ROOT/bin" && for a in x86_64-w64-mingw32 i686-w64-mingw32; do
      for t in gcc g++ cpp windres ar ranlib dlltool strip objcopy objdump; do
        if [[ ! -e "$a-$t" ]]; then
          src="$(ls "$NSIS_ROOT/usr/bin/$a-$t"-* 2>/dev/null | head -1)"
          # -f: alternatives 留下的悬空链接必须覆盖掉
          [[ -n "$src" ]] && ln -sfn "$src" "$a-$t"
        fi
      done
    done )
  if [[ ! -d "$NSIS_SRC_DIR" ]]; then
    curl -sSL -o "$tmp/nsis-src.tar.bz2" \
      "https://sourceforge.net/projects/nsis/files/NSIS%203/3.12/nsis-3.12-src.tar.bz2/download" --max-time 180
    tar xjf "$tmp/nsis-src.tar.bz2" -C "$HOME/nsis-src"
  fi
  # scons 构建（apport 钩子在这台机器上是坏的，用 runner 绕开；NSIS_SCONS_GNU_ENVPATHHACK
  # 让交叉 env 继承 PATH，否则 windres 找不到）
  cat > "$tmp/runscons.py" <<'EOF'
import sys
sys.excepthook = sys.__excepthook__
import runpy
sys.argv = ['scons'] + sys.argv[1:]
runpy.run_path('/home/REPLACEME/nsis-root/usr/bin/scons', run_name='__main__')
EOF
  sed -i "s|/home/REPLACEME|$HOME|" "$tmp/runscons.py"
  ( cd "$NSIS_SRC_DIR" \
    && export PATH="$NSIS_ROOT/bin:$NSIS_ROOT/usr/bin:$PATH" \
    && export ZLIB_W32="$NSIS_ROOT/usr/i686-w64-mingw32" \
    && export NSIS_SCONS_GNU_ENVPATHHACK=1 \
    && python3 "$tmp/runscons.py" -j"$(nproc)" VERSION=3.12 \
    && python3 "$tmp/runscons.py" install PREFIX="$NSIS_DIST" VERSION=3.12 )
  rm -rf "$tmp"
  "$MAKENSIS" -VERSION
}

if need_toolchain; then build_toolchain; else echo "toolchain OK: $("$MAKENSIS" -VERSION)"; fi

echo "== stage =="
STAGE="$(mktemp -d)/installer"
mkdir -p "$STAGE/res"
cp agent/deploy/vale-setup.nsi agent/deploy/vale-online-setup.ps1 agent/deploy/vale-agent.ico "$STAGE/"
cp agent/deploy/res/header.bmp agent/deploy/res/welcome.bmp "$STAGE/res/"

echo "== compile =="
( cd "$STAGE" && "$MAKENSIS" "-DVALE_VERSION=$VER" "-DVALE_CDN=$CDN_BASE" vale-setup.nsi )
EXE="$STAGE/ValeAgent-Setup-$VER.exe"
[[ -f "$EXE" ]] || { echo "::error::makensis produced no exe" >&2; exit 1; }
SIZE=$(stat -c %s "$EXE")
# 在线包 payload 只有 ps1+位图+ico（~240KB 未压缩），成品 ~150KB 正常；
# 空包/损坏构建远小于此。
[[ "$SIZE" -gt 120000 ]] || { echo "::error::exe suspiciously small ($SIZE bytes)" >&2; exit 1; }
# 版本号已编进文件名（OutFile ValeAgent-Setup-$VER.exe 即校验）；
# payload 经 lzma 压缩，exe 内 grep 不到明文，不做内容 grep 门。
echo "built $EXE ($SIZE bytes)"

echo "== publish to CDN staging =="
ASSET_DIR="index/public/vale-agent"
cp "$EXE" "$ASSET_DIR/ValeAgent-Setup-$VER.exe"
cp "$EXE" "$ASSET_DIR/ValeAgent-Setup.exe"
CF_TOKEN="$(cf_token)"
if [[ -z "$CF_TOKEN" ]]; then
  echo "::error::no Cloudflare token — set CLOUDFLARE_API_TOKEN or write ~/.cloudflare-token" >&2
  exit 1
fi
(cd index && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler deploy)

echo "== done =="
echo "  versioned: $CDN_BASE/vale-agent/ValeAgent-Setup-$VER.exe"
echo "  latest:    $CDN_BASE/vale-agent/ValeAgent-Setup.exe"
echo "  next: 在 Windows 沙盒机上跑一遍安装验证（见 agent/deploy/README-installer.md），再更新 index 下载页。"
