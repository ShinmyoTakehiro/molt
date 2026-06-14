#!/usr/bin/env bash
# molt を ~/.local/bin/molt に symlink して使えるようにする (F2)。
#
# 安全装置:
#   - dist/molt が無ければ build を促す
#   - 既存ファイルが symlink でない実ファイルの場合は上書きせず警告
#   - 既存 symlink で別の場所を指している場合も警告 + 確認
#   - --dry-run でプレビューのみ
#   - --uninstall で symlink 削除
#   - --force で確認スキップ

set -euo pipefail

cd "$(dirname "$0")/.."

# ─────────────────────────────────────────
# 定数 + 引数パース
# ─────────────────────────────────────────
INSTALL_DIR="$HOME/.local/bin"
LINK_PATH="$INSTALL_DIR/molt"
BINARY="$(pwd)/dist/molt"

DRY_RUN=0
UNINSTALL=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --force|-y)  FORCE=1; shift ;;
    --help|-h)
      cat <<'HELPEND'
molt インストーラ

USAGE
  ./scripts/install.sh             # symlink を作成
  ./scripts/install.sh --dry-run   # 何をするか表示するだけ
  ./scripts/install.sh --uninstall # symlink を削除
  ./scripts/install.sh --force     # 確認プロンプトをスキップ

詳細:
  ~/.local/bin/molt → $(pwd)/dist/molt の symlink を作成し、
  ~/.local/bin が PATH に入っているか確認します。
HELPEND
      exit 0 ;;
    *) echo "❌ 未知のオプション: $1" >&2; exit 1 ;;
  esac
done

# ─────────────────────────────────────────
# uninstall
# ─────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -e "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
    echo "ℹ️  $LINK_PATH は存在しません。何もしません。"
    exit 0
  fi
  if [ ! -L "$LINK_PATH" ]; then
    echo "⚠️  $LINK_PATH は symlink ではなく実ファイルです。" >&2
    echo "   このインストーラは作成した symlink のみ削除します。" >&2
    echo "   手動削除が必要な場合: rm $LINK_PATH" >&2
    exit 1
  fi
  TARGET=$(readlink "$LINK_PATH")
  echo "🗑  symlink を削除: $LINK_PATH → $TARGET"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "(dry-run: 実行しません)"
    exit 0
  fi
  rm "$LINK_PATH"
  echo "✅ アンインストール完了"
  exit 0
fi

# ─────────────────────────────────────────
# 前提チェック: バイナリが存在するか
# ─────────────────────────────────────────
if [ ! -x "$BINARY" ]; then
  echo "❌ バイナリが見つかりません: $BINARY" >&2
  echo "   先にビルドしてください: ./scripts/build.sh" >&2
  exit 1
fi
# バイナリの動作確認は install 後の最終チェックで行う (アーキ不一致等の
# 失敗時に「再ビルドしてください」と誘導できる)

# ─────────────────────────────────────────
# 既存 symlink/ファイルの扱い
# ─────────────────────────────────────────
NEEDS_CONFIRM=0
if [ -L "$LINK_PATH" ]; then
  # 相対パス symlink (例: ln -sf ./dist/molt) も同一視するため
  # readlink -f で絶対パスに解決して比較
  EXISTING_RESOLVED=$(readlink -f "$LINK_PATH" 2>/dev/null || echo "")
  BINARY_RESOLVED=$(readlink -f "$BINARY")
  if [ "$EXISTING_RESOLVED" = "$BINARY_RESOLVED" ]; then
    echo "ℹ️  既に正しい symlink が存在します: $LINK_PATH → $BINARY_RESOLVED"
    # 念のため動作確認だけして終了
  else
    echo "⚠️  既存 symlink が別の場所を指しています:"
    echo "   現在: $LINK_PATH → ${EXISTING_RESOLVED:-(dangling)}"
    echo "   新規: $LINK_PATH → $BINARY_RESOLVED"
    NEEDS_CONFIRM=1
  fi
elif [ -e "$LINK_PATH" ]; then
  echo "❌ $LINK_PATH は symlink ではなく実ファイルです。" >&2
  echo "   安全のため上書きしません。手動で削除してから再実行してください:" >&2
  echo "   rm $LINK_PATH" >&2
  exit 1
fi

# 確認プロンプト
if [ "$NEEDS_CONFIRM" -eq 1 ] && [ "$FORCE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  printf "上書きする？ [y/N]: "
  read -r ANSWER
  case "$ANSWER" in
    y|Y|yes|YES) ;;
    *) echo "中止しました。"; exit 0 ;;
  esac
fi

# ─────────────────────────────────────────
# symlink 作成
# ─────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry-run) 以下を実行する予定:"
  echo "  mkdir -p $INSTALL_DIR"
  echo "  ln -sf $BINARY $LINK_PATH"
  exit 0
fi

mkdir -p "$INSTALL_DIR"
ln -sf "$BINARY" "$LINK_PATH"
echo "✅ symlink 作成: $LINK_PATH → $BINARY"

# ─────────────────────────────────────────
# PATH チェック
# ─────────────────────────────────────────
if echo ":$PATH:" | grep -q ":$INSTALL_DIR:"; then
  echo "✅ PATH に $INSTALL_DIR が含まれています"
else
  echo ""
  echo "⚠️  PATH に $INSTALL_DIR が含まれていません。以下を ~/.zshrc などに追加してください:"
  echo ""
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
  echo "   反映後: source ~/.zshrc"
fi

# ─────────────────────────────────────────
# 動作確認
# ─────────────────────────────────────────
echo ""
echo "📋 動作確認:"
if "$LINK_PATH" help >/dev/null 2>&1; then
  VERSION_LINE=$("$LINK_PATH" help 2>&1 | head -2 | tail -1)
  echo "   $LINK_PATH ... OK"
  echo "   $VERSION_LINE"
else
  echo "   ⚠️  $LINK_PATH の動作確認に失敗" >&2
  exit 1
fi

echo ""
echo "🎉 インストール完了。"
echo "   試してみる: molt scan"
