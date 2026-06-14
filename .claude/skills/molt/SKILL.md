---
name: molt
description: Scan, classify, and safely clean up a bloated macOS disk (~/Library, ~/.cache, etc.) via the molt CLI. Use when the user wants to free disk space, find what's eating storage, review/delete caches, empty the Trash, or asks "why is my Mac full". Drives scan → preview → confirmed delete → empty-trash, proposes regenerable CAREFUL items for conversational review, and teaches the tool which paths are safe.
origin: moltmac (Free OSS)
---

# molt skill

`molt` は学習型の macOS クリーンアップ CLI。このスキルは Claude が CLI を**安全に**操作し、
ディスクのスキャン → プレビュー → 確認付き削除 → ゴミ箱空 までを案内する。

> このスキルは 🆓 Free OSS（集客プロダクト）。CLI 本体が入っていれば誰でも使える。

## いつ使うか

- 「Mac の空き容量を増やしたい / ディスクが一杯」
- 「何が容量を食ってるか調べたい」
- 「キャッシュを掃除したい / ゴミ箱を空にしたい」
- スキャン結果の分類（SAFE/CAREFUL/DANGER/UNKNOWN）の判断を手伝ってほしい

## 🔒 安全規律（必ず守る）

1. **削除は必ずプレビュー先行**: `clean` 実行前に**必ず** `--dry-run` で対象を見せ、ユーザーの**明示的な OK** を取る。
2. **明示確認なしに `clean` / `empty-trash` を実行しない**（`--yes` も `--json` も確認スキップなので、ユーザー承認後のみ付ける）。
3. **`--purge` は原則使わない**。完全削除（復元不可）。ユーザーが明示的に要求した時だけ、リスクを説明した上で。
4. **DANGER は絶対に削除提案しない**。理由を説明して除外する。
5. **CAREFUL はデフォルト対象外**。一括 `--include-careful` は使わず、**regenerable な CAREFUL だけを Step 3.5 で 1 件ずつ会話レビュー** → 承認分のみ `--paths` で削除する。
6. **現役（7 日以内に更新）項目は二段確認**。1 度目の OK で即削除せず「使用中の可能性。本当に消す？」と再確認してから `--paths` に含める。
7. ファイル**内容**は読まない・送らない（パスとサイズのみ扱う）。

## CLI の呼び出し

バイナリ解決（この順で最初に見つかったものを使う）:

1. PATH 上の `molt`（`F2` でインストール済の想定）
2. 開発リポ内なら `bun run packages/cli/src/main.ts`
3. `bun` が PATH に無い場合は `~/.bun/bin/bun` を使う

機械処理には常に `--json` を付け、`schemaVersion` 付き envelope を `stdout` から JSON パースする。

## ワークフロー

### Step 1: スキャン

```bash
molt scan --json
```

`type: "scan-report"`。読み取るキー:

| キー | 内容 |
|---|---|
| **`summaryText`** | **CLI と同一の人間可読サマリー（そのまま表示する）** |
| `diskInfo.{totalBytes,usedBytes,freeBytes}` | ディスク全体の使用状況 |
| `summary.{SAFE,CAREFUL,DANGER,UNKNOWN}.{count,sizeBytes}` | 分類別の件数・合計サイズ（補助データ） |
| `classified[]` | `{path, sizeBytes, classification, reason, decidedBy, ruleName?, regenerable?, regenCost?}` |

> `regenerable: true` の CAREFUL が Step 3.5 の会話レビュー候補。`regenCost` は再生成手段（auto/redownload/rebuild/reinstall）。

### 提示は `summaryText` を verbatim で出す（自前整形しない）

**重要**: スキャン結果のサマリーは **`summaryText` をそのまま表示**する。Claude が独自に表（markdown）へ組み直さない。
理由: CLI 出力と完全一致させ、run ごとの比較を容易にするため（自前整形はブレる）。`summaryText` は既に:
- 🗑 すぐ消せる / ♻️ 確認して消せる / 🔒 大事なデータ / ❓ 未判定 の友好ラベルで分類済み
- CAREFUL を「♻️ 再生成で戻る」「🔒 大事なデータ（消すと飛ぶ・消さない）」に分割し、安全案内付き

`summaryText` を出した上で、補足（UNKNOWN を学習で育てられる等）や Step 3.5 のレビュー提案を**会話で上乗せ**する。
正確な回収可能量は Step 3 `clean --dry-run` の `targets` 合計（dedup + 7日齢フィルタ後の実数）から取る。

### Step 2: 分類の説明

| 分類 | 意味 | デフォルト動作 |
|---|---|---|
| `SAFE` | 自動再生成され削除して安全 | `clean` 対象 |
| `CAREFUL` | ケースバイケース、要確認 | 対象外（`--include-careful` で追加可） |
| `DANGER` | 絶対に消さない | 永久除外 |
| `UNKNOWN` | ルール・学習に未該当 | 手動レビュー対象 |

### Step 3: 削除プレビュー（必須）

```bash
molt clean --dry-run --json
```

`type: "clean-report"`, `dryRun: true`, `targets[]` を一覧提示。「これらをゴミ箱へ移動します（復元可）。実行していい？」と**明示確認**。

### Step 3.5: regenerable CAREFUL の会話レビュー（v0.2・本命 UX）

SAFE だけでは回収量が小さいことが多い。**再生成可能な CAREFUL**（再 DL / 再ビルド / 再インストールで戻せるもの）を
Claude が会話で 1 件ずつ提案 → ユーザー承認分だけ `--paths` で削除する。これがこのツールの主要な節約フロー。

**候補の抽出**: Step 1 の `scan --json` の `classified[]` から、`classification === "CAREFUL" && regenerable === true` を抽出し、`sizeBytes` 降順に並べる（再 scan 不要）。

各候補をこう提示する（サイズが大きい順、上位を中心に）:

```
🔄 削除しても再生成できる CAREFUL（大きい順）:

  ① 11.5GB  Android system-image      再DL可
     /Users/.../Library/Android/sdk/system-images
     SDK Manager で再ダウンロードできる。

  ② 11.7GB  iOS シミュレータ            再インストール可
     /Users/.../Library/Developer/CoreSimulator/Devices
     Xcode が再生成。⚠️ 7日以内に使用 → 現役の可能性

どれを消す？（番号 / 全部 / やめる）
```

提示ルール:
- `regenCost` をラベル化: `auto`→「自動再生成」 / `redownload`→「再DL可」 / `rebuild`→「再ビルド可」 / `reinstall`→「再インストール可」
- **現役（7 日以内に更新 = `newestMtime` が近い）には ⚠️ を付け、選ばれても二段確認**（安全規律 6）
- 量が多い時はサイズ上位（例: 1GB 超 or Top 5〜10）に絞り、残りは件数だけ伝える
- DANGER・非 regenerable な CAREFUL は**ここに混ぜない**

**削除（承認分のみ）**: ユーザーが選んだパスを `--paths` に渡す。core 側が多層検証し、scan 外 / DANGER / 除外領域 / 非 regenerable は自動で `rejectedPaths` に弾く。

```bash
# 1) プレビュー（必須）
molt clean --dry-run --json --paths "/abs/path/A,/abs/path/B"
# → targets[] と rejectedPaths[] を提示。rejected があれば理由も伝える
# 2) 承認後に実行
molt clean --yes --json --paths "/abs/path/A,/abs/path/B"
```

> パスにカンマを含む場合は分割が壊れるので、その項目は 1 件ずつ実行する。

**学習（任意）**: ユーザーが「これは毎回消していい」と言ったら `molt decide <path> SAFE` で SAFE 昇格 → 次回から自動 clean 対象になり、提案リストが縮む。

### Step 4: 削除実行（ユーザー承認後のみ）

```bash
molt clean --yes --json     # SAFE のみ → ゴミ箱（復元可）
```

> ゴミ箱に移すだけでは**実ディスクは解放されない**（APFS は rename のみ）。解放には Step 5 が必要、と必ず伝える。

### Step 5: ゴミ箱を空にする（実ディスク解放 / ユーザー承認後のみ）

```bash
molt empty-trash --dry-run --json   # 何が消えるか確認
molt empty-trash --yes --json       # 承認後に実行（復元不可）
```

`type: "empty-trash-report"`, `diskInfo.{freeBytesBefore,freeBytesAfter}` で解放量を報告。

### Step 6: 学習（UNKNOWN を育てる）

ユーザーが UNKNOWN の扱いを決めたら記憶させる:

```bash
molt decide <path> <SAFE|CAREFUL|DANGER>   # 手動分類を学習
molt forget <path>                          # 学習を取り消し
```

次回スキャンから `decidedBy: "decision"` で反映される。

## その他コマンド

```bash
molt diff --json       # 前回スナップショットとの差分
molt history --json    # 過去の実行履歴
```

## 提示スタイル

- **スキャン結果は `summaryText` を verbatim で出す**（自前で表に組み直さない・上記 Step 1 参照）。
- 結論ファースト: 「**X GB 回収可能**。実行する？」を最初に（X は dry-run の targets 合計）。
- 自前整形してよいのは **Step 3.5 の regenerable レビュー提案** など会話で上乗せする部分のみ。
- 削除系は必ず dry-run の結果を見せてから確認。
- エラー時はパスと終了コードを添えて、握りつぶさない。
