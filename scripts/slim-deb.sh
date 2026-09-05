#!/bin/bash
# slim-deb.sh — 官方 WorkBuddy Linux .deb → 精简 .deb 转换器
#
# 输入官方 linux-x64 deb（也适用于自建 dmg→deb 产物），做两类瘦身：
#   A. 删除非本平台（win32/darwin/freebsd/openbsd/musl/ia32）的 payload
#   B. 剥离未 strip 的 ELF debug 信息（上游 libpython/node 等带完整 debug_info）
# 以及若干安全可去项（node 头文件、better-sqlite3 编译中间产物、locales 裁剪）。
#
# Usage:
#   bash scripts/slim-deb.sh /path/to/WorkBuddy-linux-x64-deb-5.5.3.*.deb
#   bash scripts/slim-deb.sh https://...deb          # 先下载再转换
# Env:
#   SLIM_KEEP_LOCALES   逗号分隔保留的 locale pak（默认 zh-CN,zh-TW,en-US,en-GB）
#   SLIM_KEEP_HEADERS   1 = 保留 node/include 头文件（默认删除，省 63M）
#   SLIM_COMPRESSION    xz（默认）| zstd  — zstd 更快但兼容性要求 dpkg>=1.21
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KEEP_LOCALES="${SLIM_KEEP_LOCALES:-zh-CN,zh-TW,en-US,en-GB}"
COMPRESSION="${SLIM_COMPRESSION:-xz}"
KEEP_HEADERS="${SLIM_KEEP_HEADERS:-0}"

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing command: $1" >&2; exit 1; }
}
require_cmd dpkg-deb
require_cmd strip
require_cmd file
require_cmd readelf
require_cmd md5sum
require_cmd python3

INPUT=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) INPUT="$1" ;;
    esac
    shift
done
[ -n "$INPUT" ] || { echo "Usage: $0 <official.deb | https URL>" >&2; exit 2; }

WORK="$(mktemp -d /tmp/wb-slim-deb.XXXXXX)"
# 环境里 rm 可能被 safe-delete shim 包装成函数；构建临时目录内直接用真 rm
rmf() { command rm -rf "$@"; }
trap 'rmf "$WORK"' EXIT

# ---------------------------------------------------------------- 下载（可选）
if [[ "$INPUT" =~ ^https?:// ]]; then
    SRC="$WORK/input.deb"
    echo "[slim] downloading $INPUT"
    curl -fL --retry 3 --retry-delay 10 -o "$SRC" "$INPUT"
else
    [ -f "$INPUT" ] || { echo "ERROR: not a file: $INPUT" >&2; exit 1; }
    SRC="$(realpath "$INPUT")"
fi

# ---------------------------------------------------------------- 解包
ROOT="$WORK/root"
echo "[slim] extracting $(basename "$SRC")"
dpkg-deb -R "$SRC" "$ROOT"
APP="$ROOT/opt/WorkBuddy"
[ -d "$APP" ] || { echo "ERROR: /opt/WorkBuddy not found in deb" >&2; exit 1; }

ORIG_INSTALLED="$(du -sk "$ROOT" | cut -f1)"
ORIG_DEB_SIZE=$(stat -c%s "$SRC")

removed_bytes_log="$WORK/removed.log"

rm_log() { # rm_log <描述> <路径...>
    local desc="$1"; shift
    # 只处理真实存在的路径，避免 shim/工具对缺失路径报错
    local -a existing=()
    local p
    for p in "$@"; do
        [ -e "$p" ] && existing+=("$p")
    done
    [ "${#existing[@]}" -gt 0 ] || return 0
    local before
    before="$(du -sk "${existing[@]}" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
    rmf "${existing[@]}"
    echo "$before|$desc" >> "$removed_bytes_log"
}

# ---------------------------------------------------------------- A. 非本平台 payload
echo "[slim] removing non-linux / other-arch payloads"

# A1. 路径含 win32 / darwin 的目录（node-pty prebuild、koffi、@lydell 包、
#     weixinpay win32 prebuilds、cli/vendor/shim/native/darwin-* 等）
while IFS= read -r -d '' d; do
    case "$d" in
        */win32*|*/darwin*) rm_log "platform dir: ${d#$APP/}" "$d" ;;
    esac
done < <(find "$APP" -type d \( -name "*win32*" -o -name "*darwin*" \) -print0)

# A2. koffi：只保留 linux_x64（其余含 freebsd/openbsd/musl/ia32/arm64 等平台）
for d in "$APP"/resources/app.asar.unpacked/node_modules/koffi/build/koffi/*/ \
         "$APP"/resources/app.asar.unpacked/cli/node_modules/koffi/build/koffi/*/; do
    [ -d "$d" ] || continue
    case "$d" in
        */linux_x64/) : ;;
        *) rm_log "koffi non-linux: ${d#$APP/}" "$d" ;;
    esac
done

# A3. macOS / 交叉平台专用 vendor 与 npm 包
rm_log "macOS vendor: cli/vendor/zsh-macos" \
       "$APP/resources/app.asar.unpacked/cli/vendor/zsh-macos"
rm_log "macOS vendor: cli/vendor/toybox-macos" \
       "$APP/resources/app.asar.unpacked/cli/vendor/toybox-macos"
rm_log "macOS-only npm: fsevents" \
       "$APP/resources/app.asar.unpacked/node_modules/fsevents" \
       "$APP/resources/app.asar.unpacked/cli/node_modules/fsevents"

# A4. better-sqlite3 编译中间产物（保留已编译 .node 本体）
rm_log "better-sqlite3 build intermediates" \
       "$APP"/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/obj.target \
       "$APP"/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/obj \
       "$APP"/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/deps \
       "$APP"/resources/app.asar.unpacked/node_modules/better-sqlite3/build/deps

# ---------------------------------------------------------------- B. 其他安全可去项
echo "[slim] trimming locales / headers / python extras"

# B1. locales 裁剪：只保留中文与英文
if [ -d "$APP/locales" ]; then
    keep_re="$(python3 -c 'print("|".join("|".join(x.split()) for x in "'$KEEP_LOCALES'".split(",")))')"
    keep_re="$(python3 - "$KEEP_LOCALES" <<'PY'
import sys
print("|".join(x.strip() for x in sys.argv[1].split(",")))
PY
)"
    while IFS= read -r -d '' f; do
        base="$(basename "$f")"
        name="${base%.pak}"
        if ! printf '%s' "$name" | grep -Eq "^($keep_re)$"; then
            rm_log "locale: $base" "$f"
        fi
    done < <(find "$APP/locales" -maxdepth 1 -type f -name "*.pak" -print0)
fi

# B2. node 头文件（仅编译 native addon 时需要；运行时不需要）
if [ "$KEEP_HEADERS" != "1" ] && [ -d "$APP/resources/runtime/node/include" ]; then
    rm_log "node headers (include/)" "$APP/resources/runtime/node/include"
fi

# B3. python 明显不会用到的交互/文档模块（体量小，顺手清）
rm_log "python idlelib/pydoc_data" \
       "$APP/resources/runtime/python/lib/python3.13/idlelib" \
       "$APP/resources/runtime/python/lib/python3.13/pydoc_data" \
       "$APP/resources/runtime/python/bin/idle3" \
       "$APP/resources/runtime/python/bin/idle3.13" \
       "$APP/resources/runtime/python/bin/pydoc3" \
       "$APP/resources/runtime/python/bin/pydoc3.13"

# ---------------------------------------------------------------- C. 剥离符号与 debug 信息
echo "[slim] stripping unstripped ELFs (debug + symtab; this takes a while...)"
STRIP_LOG="$WORK/stripped.log"
export STRIP_LOG
find "$APP" -type f -size +512k -print0 | while IFS= read -r -d '' f; do
    # 快速判别 ELF
    head -c 4 "$f" 2>/dev/null | grep -q $'\x7fELF' || continue
    # 只处理 "not stripped" 的文件
    file -b "$f" | grep -q "not stripped" || continue
    # 注意：个别上游二进制（如 python3.13 本体）布局畸形（allocated section
    # 不在 PT_LOAD 殄内），任何 strip/objcopy 重写都会导致 "symbol lookup error"。
    # binutils 重写这类文件时会打 "allocated section ... not in segment" 警告，
    # 因此 strip 到临时文件，检测到警告或失败就保留原件。
    before=$(stat -c%s "$f")
    tmp_out="$f.slim-strip.$$"
    strip_err="$(strip --strip-debug -o "$tmp_out" "$f" 2>&1)" || { command rm -f "$tmp_out"; continue; }
    if printf '%s' "$strip_err" | grep -q "not in segment"; then
        command rm -f "$tmp_out"
        continue
    fi
    after=$(stat -c%s "$tmp_out")
    if [ "$after" -lt "$before" ] && mv -f "$tmp_out" "$f"; then
        echo "$((before - after))|$f" >> "$STRIP_LOG"
    else
        command rm -f "$tmp_out"
    fi
done

# ---------------------------------------------------------------- D. 重建 deb 元数据
echo "[slim] regenerating md5sums"
{
    cd "$ROOT"
    find opt usr -type f ! -path "*/DEBIAN/*" -print0 2>/dev/null | while IFS= read -r -d '' f; do
        md5sum "$f"
    done
} > "$ROOT/DEBIAN/md5sums"

NEW_INSTALLED="$(du -sk "$ROOT" | cut -f1)"

# control：加 slim 版本后缀与说明，更新 Installed-Size
python3 - "$ROOT/DEBIAN/control" "$NEW_INSTALLED" <<'PY'
import sys

path, installed = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
out = []
for line in lines:
    if line.startswith("Version:"):
        pkg_version = line.split(":", 1)[1].strip()
        if "slim" not in pkg_version:
            line = f"Version: {pkg_version}+slim1"
    if line.startswith("Installed-Size:"):
        line = f"Installed-Size: {installed}"
    if line.startswith("Description:"):
        line += " [workbuddy-linux slim rebuild: non-official, cross-platform payload and debug info removed]"
    out.append(line)
open(path, "w").write("\n".join(out) + "\n")
PY

PKG_NAME="$(awk '/^Package:/{print $2}' "$ROOT/DEBIAN/control")"
PKG_VER="$(awk '/^Version:/{print $2}' "$ROOT/DEBIAN/control")"
OUT_DIR="$REPO_DIR/dist"
mkdir -p "$OUT_DIR"
OUT_DEB="$OUT_DIR/${PKG_NAME}_${PKG_VER}_amd64_slim.deb"

# 构建前冒烟测试：确认 strip 沇没弄坏内置 runtime
echo "[slim] smoke-testing stripped runtimes"
NODE_BIN="$APP/resources/runtime/node/bin/node"
PY_BIN="$APP/resources/runtime/python/bin/python3.13"
[ -x "$NODE_BIN" ] && "$NODE_BIN" --version >/dev/null 2>&1 || { echo "ERROR: node runtime broken after strip" >&2; exit 1; }
[ -x "$PY_BIN" ] && "$PY_BIN" --version >/dev/null 2>&1 || { echo "ERROR: python runtime broken after strip" >&2; exit 1; }
echo "[slim] runtimes OK: $("$NODE_BIN" --version) / $("$PY_BIN" --version)"

echo "[slim] building $(basename "$OUT_DEB") ($COMPRESSION)"
case "$COMPRESSION" in
    zstd) dpkg-deb --root-owner-group -Zzstd --build "$ROOT" "$OUT_DEB" ;;
    *)    dpkg-deb --root-owner-group -Zxz --build "$ROOT" "$OUT_DEB" ;;
esac

# ---------------------------------------------------------------- 报告
echo
echo "================ 瘦身报告 ================"
if [ -f "$removed_bytes_log" ]; then
    python3 - "$removed_bytes_log" <<'PY'
import sys
rows = []
for line in open(sys.argv[1]):
    size, desc = line.rstrip("\n").split("|", 1)
    rows.append((int(size), desc))
rows.sort(reverse=True)
total = sum(r[0] for r in rows)
for size, desc in rows[:20]:
    print(f"  {size/1024:9.1f} MiB  {desc}")
print(f"  {'-'*40}")
print(f"  {total/1024:9.1f} MiB  合计（删除项，top20 展示）")
PY
fi
if [ -f "$STRIP_LOG" ]; then
    python3 - "$STRIP_LOG" <<'PY'
import sys
rows = []
for line in open(sys.argv[1]):
    size, path = line.rstrip("\n").split("|", 1)
    rows.append((int(size), path))
rows.sort(reverse=True)
total = sum(r[0] for r in rows)
for size, path in rows[:15]:
    short = path.split("/opt/WorkBuddy/")[-1]
    print(f"  {size/1024/1024:9.1f} MiB  strip: {short}")
print(f"  {'-'*40}")
print(f"  {total/1024/1024:9.1f} MiB  strip 节省合计（{len(rows)} 个文件）")
PY
fi
NEW_DEB_SIZE=$(stat -c%s "$OUT_DEB")
python3 - "$ORIG_DEB_SIZE" "$NEW_DEB_SIZE" "$ORIG_INSTALLED" "$NEW_INSTALLED" <<'PY'
import sys
o, n, oi, ni = (int(x) for x in sys.argv[1:5])
print(f"  deb     : {o/1024/1024:7.1f} MiB → {n/1024/1024:7.1f} MiB  (-{(1-n/o)*100:.0f}%)")
print(f"  安装体积: {oi/1024:7.1f} MiB → {ni/1024:7.1f} MiB  (-{(1-ni/oi)*100:.0f}%)")
PY
echo "=========================================="
echo "[slim] done: $OUT_DEB"
