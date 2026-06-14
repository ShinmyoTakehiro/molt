#!/usr/bin/env bash
# molt を単一バイナリにビルドする (F1)。
#
# 出力: ./dist/molt (CPU 自動検出 or --arch で明示指定)
#
# 使い方:
#   ./scripts/build.sh                # 現在の CPU 向けにビルド
#   ./scripts/build.sh --arch arm64   # Apple Silicon
#   ./scripts/build.sh --arch x64     # Intel Mac
#   ./scripts/build.sh --arch both    # 両方ビルド (molt-arm64 / molt-x64)

set -euo pipefail

cd "$(dirname "$0")/.."

# ─────────────────────────────────────────
# bun を探す (PATH に無くても ~/.bun/bin 等を確認)
# ─────────────────────────────────────────
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for cand in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "/usr/local/bin/bun"; do
    if [ -x "$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

BUN=$(find_bun) || {
  echo "❌ bun が見つかりません。" >&2
  echo "   インストール: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

# ─────────────────────────────────────────
# 引数パース
# ─────────────────────────────────────────
ARCH="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      if [ $# -lt 2 ]; then
        echo "❌ --arch に値が必要です (arm64 / x64 / both)" >&2
        exit 1
      fi
      ARCH="$2"; shift 2 ;;
    --help|-h)
      cat <<'BUILDHELP'
molt ビルダ

USAGE
  ./scripts/build.sh                # 現在の CPU 向け
  ./scripts/build.sh --arch arm64   # Apple Silicon
  ./scripts/build.sh --arch x64     # Intel Mac
  ./scripts/build.sh --arch both    # 両方
BUILDHELP
      exit 0 ;;
    *)
      echo "❌ 未知のオプション: $1" >&2
      exit 1 ;;
  esac
done

# auto → 実ハードの CPU を検出
# 注意: `uname -m` は bun/シェルが Rosetta(x86_64) 経由だと arm64 機でも
# x86_64 を返し、x64 バイナリを誤ってビルド→実行時 exit 132 (SIGILL) になる。
# sysctl hw.optional.arm64 は Rosetta 下でも実ハードの arch を返す
# (install-online.sh の実機 arch 判定と同一方式)。
if [ "$ARCH" = "auto" ]; then
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    ARCH="arm64"
  else
    ARCH="x64"
  fi
fi

# ─────────────────────────────────────────
# ビルド実行
# ─────────────────────────────────────────
mkdir -p dist

build_one() {
  local arch="$1"
  local outfile="$2"
  local target="bun-darwin-$arch"

  echo "🔨 ビルド中 ($target)…"
  "$BUN" build packages/cli/src/main.ts \
    --compile \
    --minify \
    --target="$target" \
    --outfile="$outfile"
  chmod +x "$outfile"
  local size
  size=$(du -h "$outfile" | cut -f1)
  echo "✅ $outfile ($size)"
}

case "$ARCH" in
  arm64|x64)
    build_one "$ARCH" "dist/molt"
    BINARY="dist/molt"
    ;;
  both)
    build_one "arm64" "dist/molt-arm64"
    build_one "x64"   "dist/molt-x64"
    BINARY="dist/molt-arm64 dist/molt-x64"
    ;;
  *)
    echo "❌ --arch は arm64 / x64 / both のいずれか (got: $ARCH)" >&2
    exit 1 ;;
esac

echo ""
echo "📦 出力: $BINARY"
echo ""
echo "次のステップ:"
echo "  ./scripts/install.sh         # ~/.local/bin に symlink + PATH 確認"
echo "  sudo cp dist/molt /usr/local/bin/   # システム全体 (sudo 要)"
