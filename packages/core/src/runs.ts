// Run-based ストレージ管理。
//
// 各実行（scan / clean / diff）を 1 つの run = 1 フォルダにまとめる。
// 関連する snapshot / log / report が同じディレクトリ内にあり、
// `latest` シンボリックリンクと `index.json` で高速アクセス可能。
//
// レイアウト:
//   ~/.local/share/moltmac/
//   ├── runs/
//   │   ├── 2026-05-17T15-25-45Z/
//   │   │   ├── meta.json       (run 情報、終了後に更新)
//   │   │   ├── snapshot.json   (scan/clean 時のスキャン結果)
//   │   │   ├── log.json        (clean 実行ログ)
//   │   │   └── report.md       (人間可読レポート)
//   │   └── latest -> 2026-05-17T15-25-45Z/   (シンボリックリンク)
//   └── index.json              (全 run のメタデータ、高速クエリ用)

import { existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { checkSchemaVersion, withSchema } from './types.ts';

export const RUNS_DIR = join(DATA_DIR, 'runs');
export const INDEX_FILE = join(DATA_DIR, 'index.json');
export const LATEST_LINK = join(RUNS_DIR, 'latest');

/** index.json に保持する run 履歴の上限 */
export const MAX_INDEX_ENTRIES = 100;
/** runs/ ディレクトリに保持する run の上限（超過時に古い物を物理削除）*/
export const MAX_RUNS_RETAINED = 50;

export type RunType = 'scan' | 'clean' | 'diff' | 'empty-trash';

/**
 * Run のメタデータ。
 * startRun() で初期化、Run.finish() で完了情報追加。
 */
export interface RunMeta {
  readonly id: string;                  // ISO timestamp (`:` を `-` に置換)
  readonly type: RunType;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly command: string;             // 例: `molt clean --dry-run`
  readonly args: ReadonlyArray<string>;
  readonly freedBytes?: number;         // clean 時のみ
  readonly successCount?: number;       // clean 時のみ
  readonly errorCount?: number;         // clean 時のみ
  readonly skippedCount?: number;       // clean 時のみ
  readonly dryRun?: boolean;            // clean 時のみ
  readonly mode?: 'trash' | 'purge';    // clean 時のみ
  readonly freeBytesBefore?: number;    // ディスク空き(開始時)
  readonly freeBytesAfter?: number;     // ディスク空き(終了時)
}

export interface IndexFile {
  /** スキーマバージョン (現在: 1)。後方互換のため optional + legacy `version` 併存 */
  readonly schemaVersion?: number;
  /** @deprecated `schemaVersion` を使う (loadIndex で自動マイグレート) */
  readonly version?: number;
  readonly runs: ReadonlyArray<RunMeta>;
}

/**
 * 1 つの実行を表すハンドル。
 * meta.json は常にディスクに同期される。
 */
export class Run {
  public meta: RunMeta;

  constructor(
    public readonly id: string,
    public readonly dir: string,
    meta: RunMeta,
  ) {
    this.meta = meta;
  }

  /**
   * run ディレクトリ内にファイルを書き込む（例: 'snapshot.json'）。
   */
  async writeFile(name: string, content: string): Promise<string> {
    const path = join(this.dir, name);
    await Bun.write(path, content);
    return path;
  }

  /**
   * 完了処理: meta 更新 + latest 更新 + index 追記 + 古い run 削除。
   */
  async finish(updates: Partial<RunMeta> = {}): Promise<void> {
    this.meta = {
      ...this.meta,
      finishedAt: new Date().toISOString(),
      ...updates,
    };
    await Bun.write(
      join(this.dir, 'meta.json'),
      JSON.stringify(withSchema(this.meta), null, 2),
    );
    updateLatestLink(this.id);
    await appendToIndex(this.meta);
    await pruneOldRuns();
  }
}

/**
 * 新規 run を開始する。フォルダ作成 + 初期 meta.json 書き込み。
 */
export async function startRun(
  type: RunType,
  argv: ReadonlyArray<string>,
): Promise<Run> {
  await mkdir(RUNS_DIR, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(RUNS_DIR, id);
  await mkdir(dir, { recursive: true });

  const initialArgs = argv.slice(2);
  const meta: RunMeta = {
    id,
    type,
    startedAt: new Date().toISOString(),
    command: `molt ${initialArgs.join(' ')}`.trim(),
    args: initialArgs,
  };
  await Bun.write(join(dir, 'meta.json'), JSON.stringify(withSchema(meta), null, 2));
  return new Run(id, dir, meta);
}

/**
 * latest シンボリックリンクを最新 run へ更新。
 */
function updateLatestLink(id: string): void {
  const target = join(RUNS_DIR, id);
  try {
    rmSync(LATEST_LINK);
  } catch {
    // 元々無ければ問題なし
  }
  try {
    symlinkSync(target, LATEST_LINK);
  } catch {
    // 失敗しても致命的ではない
  }
}

/**
 * index.json に run 情報を追記。古い物は切り捨て。
 */
async function appendToIndex(meta: RunMeta): Promise<void> {
  const file = await loadIndex();
  const runs = [...file.runs, meta];
  const trimmed = runs.length > MAX_INDEX_ENTRIES ? runs.slice(-MAX_INDEX_ENTRIES) : runs;
  await Bun.write(INDEX_FILE, JSON.stringify(withSchema({ runs: trimmed }), null, 2));
}

/**
 * index.json を読み込む。存在しなければ空。
 * schemaVersion 不一致は warn のみで読込続行 (G1)。
 */
export async function loadIndex(): Promise<IndexFile> {
  if (!existsSync(INDEX_FILE)) return { schemaVersion: 1, runs: [] };
  const content = await Bun.file(INDEX_FILE).text();
  const parsed = JSON.parse(content) as IndexFile;
  if (parsed.schemaVersion !== undefined) {
    checkSchemaVersion(parsed, INDEX_FILE);
  } else if (parsed.version !== undefined) {
    console.warn(`⚠️  ${INDEX_FILE}: legacy 'version' フィールド検出 (v${parsed.version})。次回保存時に schemaVersion に移行されます`);
  } else {
    console.warn(`⚠️  ${INDEX_FILE}: schemaVersion 欠落`);
  }
  return parsed;
}

/**
 * runs/ 配下の run id 一覧を新しい順で返す。
 */
export function listRunIds(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f !== 'latest' && /^\d{4}-\d{2}-\d{2}T/.test(f))
    .sort()
    .reverse();
}

/**
 * 特定 run のディレクトリパスを返す。
 */
export function getRunDir(id: string): string {
  return join(RUNS_DIR, id);
}

/**
 * latest シンボリックリンクのパス（存在チェック付き）。
 */
export function getLatestRunDir(): string | null {
  return existsSync(LATEST_LINK) ? LATEST_LINK : null;
}

/**
 * 保持上限を超えた古い run を物理削除。
 */
async function pruneOldRuns(): Promise<void> {
  const ids = listRunIds();
  if (ids.length <= MAX_RUNS_RETAINED) return;
  const toDelete = ids.slice(MAX_RUNS_RETAINED);
  for (const id of toDelete) {
    try {
      await rm(join(RUNS_DIR, id), { recursive: true, force: true });
    } catch {
      // 個別の失敗は致命的ではない
    }
  }
}
