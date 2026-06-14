# molt

**学習しながら Mac のディスクを安全に減らす、育てるキャッシュクリーナー。**

`~/Library` や `~/.cache` の肥大化を検出・分類し、**ゴミ箱経由（復元可）**で削除する macOS CLI。
内部の専門用語ではなく「🗑 すぐ消せる / ♻️ 確認して消せる / 🔒 大事なデータ / ❓ 未判定」で見せ、
あなたの判定を記憶して育つホワイトリスト型。**ファイルの中身は一切読みません。**

> molt = 脱皮。古いキャッシュを安全に脱ぎ捨てて、Mac を身軽に保つ。

## なぜ molt か

| | molt | 一般的なクリーナー |
|---|---|---|
| 安全 | ゴミ箱経由・SAFE のみ自動・多層除外 | 一括削除しがち |
| 学習 | あなたの判定を記憶して次回自動化 | 毎回同じ確認 |
| 透明 | パスとサイズだけ・中身は読まない | 不透明なことも |
| 操作 | CLI でスクリプタブル + Claude Code ネイティブ | GUI のみ |

## インストール

### Homebrew（推奨）

```bash
brew install ShinmyoTakehiro/tap/molt
```

### curl ワンライナー

```bash
curl -fsSL https://raw.githubusercontent.com/ShinmyoTakehiro/molt/main/scripts/install-online.sh | bash
```

最新リリースから CPU(arm64/x64) を自動判定してバイナリを取得し、`~/.local/bin/molt` に置く。

### ソースから

```bash
# Bun 未導入なら先に入れる（要 1.3.14+）
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/ShinmyoTakehiro/molt.git
cd molt
bun install
./scripts/build.sh            # → ./dist/molt（単一バイナリ）
./scripts/install.sh          # → ~/.local/bin/molt に symlink（PATH も確認）

molt help                     # 動作確認
```

> `~/.local/bin` が PATH に無い場合は `install.sh` が警告を出すので、案内に従って追加する。

## クイックスタート

```bash
molt scan                  # スキャン + 分類 + レポート
molt clean --dry-run       # 何がゴミ箱に移るか確認（プレビュー）
molt clean                 # 「すぐ消せる」だけゴミ箱へ（実行前に確認）
molt empty-trash           # ゴミ箱を空にして実ディスクを解放
```

`scan` の出力はこんな感じ:

```
🗑  すぐ消せる:        1.84GB   キャッシュ等・消しても自動で戻る
♻️  確認して消せる:   16.40GB   再生成/再DLで戻る
🔒  大事なデータ:     30.10GB   消すとアプリ設定・データが飛ぶ
❓  未判定:            1.30GB   ルール未該当

♻️ 確認して消せる (2件) ── 消しても元に戻せる:
       11.70GB  ~/Library/Developer/CoreSimulator/Devices
              └ シミュレータ再作成で復元（数分）
        4.70GB  ~/Library/Developer/Xcode/iOS DeviceSupport
              └ デバイス再接続で自動再生成
────────────────────────────────────────────────────────────
🗑 molt clean               すぐ消せるものをゴミ箱へ（大事なデータは消えません）
♻️ molt clean --interactive   確認して消せるものを1件ずつ削除
```

## コマンド一覧

```bash
molt scan                    # ディスクをスキャンして分類レポートを表示
molt clean                   # 「すぐ消せる」をゴミ箱へ移動（要確認）
molt clean --dry-run         # 削除せず対象だけ表示
molt clean --yes             # 確認プロンプトをスキップ
molt clean --interactive     # 再生成可な「確認して消せる」を1件ずつ承認して追加
molt empty-trash             # ゴミ箱を空にして実ディスクを解放（要確認）
molt diff                    # 前回スナップショットとの差分
molt history                 # 過去の実行履歴
molt decide <path> SAFE      # 特定パスを手動分類（学習させる）
molt forget <path>           # 学習データから判定を削除
```

すべてのコマンドは `--json` で `schemaVersion` 付きの構造化出力に切り替わる（GUI / スクリプト連携用）。

> 💡 ゴミ箱に移すだけでは**実ディスクは解放されない**（APFS は rename のみ）。
> 解放するには `empty-trash` でゴミ箱を空にする。

> ⏱ **初回 `scan` は `~/Library` 全走査で数分かかることがある**（環境により最大 ~20分）。
> 固まったわけではない。2回目以降は OS のディスクキャッシュが効いて高速になる。

## 表示ラベルの意味

molt は内部分類（SAFE/CAREFUL/DANGER）をそのまま見せず、「消していい度」で表示する:

| ラベル | 意味 | clean の挙動 |
|---|---|---|
| 🗑 すぐ消せる | キャッシュ等・消しても自動で戻る | `clean` で自動対象 |
| ♻️ 確認して消せる | 再生成/再DLで戻る（iOS シミュ等） | `clean --interactive` で1件ずつ承認 |
| 🔒 大事なデータ | 消すとアプリ設定・データが飛ぶ | `clean` では**消えない** |
| ❓ 未判定 | ルール未該当 | 手動 `decide` で学習 |

## 🤖 Claude Code skill

`/molt` スキルを使うと、Claude Code が対話でスキャン → プレビュー → 確認付き削除を案内する。
「再生成可能な CAREFUL」を会話でレビューして安全に回収できるのが、AI ネイティブな molt ならでは。

```bash
# このリポの skill をユーザー領域へ
mkdir -p ~/.claude/skills/molt
cp .claude/skills/molt/SKILL.md ~/.claude/skills/molt/
```

Claude Code で「Mac の空き容量を増やしたい」と言うとスキルが起動し、安全規律に沿って案内する。

## 安全設計

- **削除はプレビュー先行** — `clean` は実行前に確認プロンプト。`--dry-run` で事前に対象を確認
- **ゴミ箱経由（復元可）** — 完全削除は `--purge` 明示時のみ
- **「すぐ消せる」のみ自動** — 「確認して消せる」は `--interactive`/`--include-careful` 明示時のみ、「大事なデータ」は永久除外
- **ハードコード除外** — Documents / Desktop / Pictures / .ssh などは絶対に触らない
- **年齢フィルタ** — 7 日以内に変更されたファイルを含むディレクトリはスキップ

## プライバシー

- **ファイルの中身は読まない** — 扱うのは**パスとサイズのみ**。AI にファイル内容を送ることはない。
- **記録はローカルのみ** — 実行したコマンドと対象パスは `~/.local/share/moltmac/runs/<id>/meta.json` にローカル記録される（**ファイルの中身は記録しない**）。学習データは `~/.config/moltmac/` に保存。外部送信なし。

## 既知の制限

- **`empty-trash` で実ディスクを解放するには権限が必要** — macOS の TCC 保護により、ターミナル等から `~/.Trash` を空にするには**フルディスクアクセス**の許可が要る。許可がない場合は `empty-trash` がエラーになる（偽の成功は返さない）。手動なら **Finder の「ゴミ箱を空にする」**で確実に解放できる。
- **対応プラットフォームは macOS のみ** — パス分類とハードコード除外は macOS の `~/Library` 構造前提。
- **学習データはローカルのみ** — マルチ Mac 同期は未対応。

## アーキテクチャ

```
packages/
├── core/    # コアロジック（scanner / classifier / cleaner / reporter）
└── cli/     # CLI エントリ（Bun build で単一バイナリ化）
```

データ保存（XDG 準拠）:

```
~/.config/moltmac/decisions.json        # 学習データ
~/.local/share/moltmac/runs/<id>/       # 実行記録（コマンド・パス・サマリ／中身は含まない）
~/.local/share/moltmac/runs/latest      # 最新 run への symlink
```

## 開発

```bash
bun install
bun run packages/cli/src/main.ts scan
bun test          # ユニットテスト
bun run typecheck # tsc --noEmit
```

## ロードマップ

| 状態 | 内容 |
|---|---|
| ✅ | CLI（scan / clean / empty-trash / 学習 / 履歴） |
| ✅ | 友好ラベル + regenerable CAREFUL 対話レビュー（`--interactive`） |
| ✅ | Claude Code skill（`/molt`） |
| 🗒️ | 月次自動チェック（launchd） |
| 🗒️ | メニューバー常駐 + AI 自動分類 |

## ライセンス

MIT — [LICENSE](./LICENSE)
