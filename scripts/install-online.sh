#!/usr/bin/env bash
# molt online installer
#
#   curl -fsSL https://raw.githubusercontent.com/ShinmyoTakehiro/molt/main/scripts/install-online.sh | bash
#
# 最新 GitHub Release から CPU(arm64/x64) に合うバイナリを取得し、
# sha256 を検証して ~/.local/bin/molt に置く。
#
# 環境変数:
#   MOLT_INSTALL_DIR  インストール先 (default: ~/.local/bin)
#   MOLT_VERSION      取得するタグ (default: latest)

set -euo pipefail

REPO="ShinmyoTakehiro/molt"
INSTALL_DIR="${MOLT_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${MOLT_VERSION:-latest}"

err() { echo "❌ $*" >&2; exit 1; }
info() { echo "→ $*"; }

# ── macOS 限定 ──────────────────────────────
[ "$(uname -s)" = "Darwin" ] || err "molt は macOS 専用です (検出: $(uname -s))"

# ── CPU arch 検出 (Rosetta 下でも実機 arch を見る) ──
# uname -m は Rosetta 経由だと x86_64 を返すため sysctl で実ハードを判定。
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arm64"
else
  ARCH="x64"
fi
ASSET="molt-$ARCH"
info "CPU: $ARCH → $ASSET"

# ── 依存チェック ────────────────────────────
command -v curl >/dev/null 2>&1 || err "curl が必要です"
SHASUM=""
if command -v shasum >/dev/null 2>&1; then SHASUM="shasum -a 256"; fi

# ── リリース URL を解決 ─────────────────────
if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "ダウンロード中: $BASE/$ASSET"
curl -fsSL "$BASE/$ASSET" -o "$TMP/molt" || err "バイナリ取得に失敗 ($BASE/$ASSET)"

# ── sha256 検証 (asset があれば) ────────────
if [ -n "$SHASUM" ] && curl -fsSL "$BASE/$ASSET.sha256" -o "$TMP/molt.sha256" 2>/dev/null; then
  EXPECTED="$(cut -d' ' -f1 < "$TMP/molt.sha256")"
  ACTUAL="$($SHASUM "$TMP/molt" | cut -d' ' -f1)"
  [ "$EXPECTED" = "$ACTUAL" ] || err "sha256 不一致 (expected=$EXPECTED actual=$ACTUAL)"
  info "sha256 検証 OK"
else
  echo "⚠️  sha256 検証をスキップ (チェックサム未取得)" >&2
fi

# ── 配置 ────────────────────────────────────
mkdir -p "$INSTALL_DIR"
chmod +x "$TMP/molt"
mv "$TMP/molt" "$INSTALL_DIR/molt"
info "インストール完了: $INSTALL_DIR/molt"

# ── PATH 案内 ───────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "⚠️  $INSTALL_DIR が PATH にありません。シェル設定に追加してください:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "✅ molt をインストールしました。まずは:  molt scan"
