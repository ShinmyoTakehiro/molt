#!/usr/bin/env bash
# molt リリース自動化 (A4)。
#
# version 上げる度の手作業を 1 コマンド化する:
#   再ビルド(both) → lipo で universal 化 → :all bottle 再生成
#   → arm64/x64/bottle の sha256 算出 → tap の formula を更新
#   → (--publish 時のみ) GitHub Release 作成 + tap push
#
# 使い方:
#   ./scripts/release.sh 0.3.0              # ローカルで成果物+formula更新まで (push しない)
#   ./scripts/release.sh 0.3.0 --publish    # release 作成 + tap push まで実行 (要 gh 認証)
#
# 環境変数:
#   MOLT_TAP_DIR   homebrew-tap repo の場所 (default: <molt>/../homebrew-tap)
#   MOLT_REPO      GitHub repo (default: ShinmyoTakehiro/molt)
#
# 設計: push 等の不可逆・外向き操作は --publish を付けた時だけ。
#       既定はローカル成果物の生成と formula 更新で止まり、publish コマンドを表示する。

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

MOLT_REPO="${MOLT_REPO:-ShinmyoTakehiro/molt}"
MOLT_TAP_DIR="${MOLT_TAP_DIR:-$REPO_ROOT/../homebrew-tap}"

err()  { echo "❌ $*" >&2; exit 1; }
info() { echo "→ $*"; }
ok()   { echo "✅ $*"; }

# ── 引数 ────────────────────────────────────
VERSION=""
PUBLISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) err "未知のオプション: $1" ;;
    *)  [ -z "$VERSION" ] || err "version は1つだけ"; VERSION="$1"; shift ;;
  esac
done

[ -n "$VERSION" ] || err "version が必要です  (例: ./scripts/release.sh 0.3.0)"
# semver 形式の最小チェック (x.y.z)
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || err "version は x.y.z 形式で (got: $VERSION)"

TAG="v$VERSION"
DL_BASE="https://github.com/$MOLT_REPO/releases/download/$TAG"

# ── 依存チェック ────────────────────────────
command -v lipo   >/dev/null 2>&1 || err "lipo が必要です (Xcode CLT)"
command -v shasum >/dev/null 2>&1 || err "shasum が必要です"
[ -f "$MOLT_TAP_DIR/Formula/molt.rb" ] \
  || err "tap formula が見つかりません: $MOLT_TAP_DIR/Formula/molt.rb  (MOLT_TAP_DIR を確認)"
if [ "$PUBLISH" = "1" ]; then
  command -v gh  >/dev/null 2>&1 || err "--publish には gh CLI が必要です"
  command -v git >/dev/null 2>&1 || err "--publish には git が必要です"
fi

echo ""
info "molt $VERSION リリース成果物を生成します"
info "tap: $MOLT_TAP_DIR"
[ "$PUBLISH" = "1" ] && info "モード: PUBLISH (release 作成 + tap push まで)" \
                     || info "モード: ローカルのみ (push しない)"
echo ""

# ── 1. 両 arch ビルド ───────────────────────
info "[1/6] arm64 + x64 をビルド"
./scripts/build.sh --arch both

ARM="dist/molt-arm64"
X64="dist/molt-x64"
[ -f "$ARM" ] && [ -f "$X64" ] || err "ビルド成果物が見つかりません ($ARM / $X64)"

# 各 slice が正しい arch か検証 (E1 の誤arch混入を早期検知)
[ "$(lipo -archs "$ARM")" = "arm64" ]  || err "$ARM が arm64 でない: $(lipo -archs "$ARM")"
[ "$(lipo -archs "$X64")" = "x86_64" ] || err "$X64 が x86_64 でない: $(lipo -archs "$X64")"
ok "両 arch ビルド OK"

# ── 2. universal binary 化 ──────────────────
info "[2/6] lipo で universal 化"
UNI="dist/molt-universal"
lipo -create "$ARM" "$X64" -output "$UNI"
chmod +x "$UNI"
# B1 ガード: 両 slice が揃っているか検証 (入力ファイルが先・-verify_arch は後)
lipo "$UNI" -verify_arch x86_64 arm64 \
  || err "universal binary に x86_64/arm64 が揃っていません: $(lipo -archs "$UNI")"
ok "universal: $(lipo -archs "$UNI")"

# ── 3. :all bottle 生成 ─────────────────────
# Homebrew bottle 構造: molt/<version>/bin/molt + 空の .brew/
info "[3/6] :all bottle tarball を生成"
BOTTLE="dist/molt-$VERSION.all.bottle.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/molt/$VERSION/bin" "$STAGE/molt/$VERSION/.brew"
cp "$UNI" "$STAGE/molt/$VERSION/bin/molt"
chmod +x "$STAGE/molt/$VERSION/bin/molt"
# COPYFILE_DISABLE=1 で macOS の ._AppleDouble / xattr を tarball に混ぜない
( cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$REPO_ROOT/$BOTTLE" molt )
ok "bottle: $BOTTLE ($(du -h "$BOTTLE" | cut -f1))"

# ── 4. sha256 算出 ──────────────────────────
info "[4/6] sha256 算出"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
SHA_ARM="$(sha "$ARM")"
SHA_X64="$(sha "$X64")"
SHA_BOTTLE="$(sha "$BOTTLE")"
# 各バイナリ横に .sha256 も生成 (install-online.sh が検証に使う形式)
echo "$SHA_ARM  molt-arm64" > "$ARM.sha256"
echo "$SHA_X64  molt-x64"   > "$X64.sha256"
ok "arm64=$SHA_ARM"
ok "x64  =$SHA_X64"
ok "bottle=$SHA_BOTTLE"

# ── 5. tap formula 更新 ─────────────────────
info "[5/6] formula を更新: $MOLT_TAP_DIR/Formula/molt.rb"
cat > "$MOLT_TAP_DIR/Formula/molt.rb" <<FORMULA
class Molt < Formula
  desc "Learning macOS cache cleaner that shrinks Library caches safely via Trash"
  homepage "https://github.com/$MOLT_REPO"
  version "$VERSION"
  license "MIT"

  # Universal (Intel + Apple Silicon) prebuilt binary, tagged :all so it is
  # poured on every macOS version/arch. Pouring a bottle skips Homebrew's
  # build-from-source CLT check and is not quarantined, so the unsigned binary
  # runs without a Gatekeeper prompt.
  bottle do
    root_url "$DL_BASE"
    sha256 cellar: :any_skip_relocation, all: "$SHA_BOTTLE"
  end

  # Source-fallback (\`--build-from-source\`) only; normal installs pour the
  # universal :all bottle above. Per-arch URLs use an explicit conditional
  # because Homebrew's ComponentsOrder cop disallows url/sha256 inside on_arm.
  if Hardware::CPU.arm?
    url "$DL_BASE/molt-arm64"
    sha256 "$SHA_ARM"
  else
    url "$DL_BASE/molt-x64"
    sha256 "$SHA_X64"
  end

  def install
    bin.install Dir["molt-*"].first => "molt"
  end

  test do
    assert_match "molt", shell_output("#{bin}/molt help")
  end
end
FORMULA
ok "formula 更新済 (version $VERSION / 3 sha 反映)"

# ── 6. publish (--publish 時のみ) ───────────
RELEASE_ASSETS="$ARM $ARM.sha256 $X64 $X64.sha256 $BOTTLE"
if [ "$PUBLISH" = "1" ]; then
  info "[6/6] GitHub Release $TAG を作成 + アセット upload"
  # shellcheck disable=SC2086
  gh release create "$TAG" $RELEASE_ASSETS \
    --repo "$MOLT_REPO" \
    --title "molt $VERSION" \
    --generate-notes
  info "tap を commit + push"
  git -C "$MOLT_TAP_DIR" add Formula/molt.rb
  git -C "$MOLT_TAP_DIR" commit -m "🍺 molt: bump to $VERSION"
  git -C "$MOLT_TAP_DIR" push
  echo ""
  ok "リリース $TAG 公開完了"
  echo "   検証: brew uninstall molt 2>/dev/null; brew install $MOLT_REPO/tap/molt && molt help"
else
  echo ""
  info "[6/6] ローカル生成完了 (push していません)。公開するには:"
  echo ""
  echo "  # 1) GitHub Release + アセット"
  echo "  gh release create $TAG \\"
  echo "    $RELEASE_ASSETS \\"
  echo "    --repo $MOLT_REPO --title \"molt $VERSION\" --generate-notes"
  echo ""
  echo "  # 2) tap を push"
  echo "  git -C \"$MOLT_TAP_DIR\" add Formula/molt.rb"
  echo "  git -C \"$MOLT_TAP_DIR\" commit -m \"🍺 molt: bump to $VERSION\""
  echo "  git -C \"$MOLT_TAP_DIR\" push"
  echo ""
  echo "  # または: ./scripts/release.sh $VERSION --publish"
fi
