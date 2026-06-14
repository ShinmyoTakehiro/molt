// スナップショット管理。スキャン結果を時系列で保存し、差分検出に使う。
//
// 永続化は Run ベース（runs/<id>/snapshot.json）。
// 旧 SNAPSHOT_DIR 配下のレガシーデータも読み取り可能（フォールバック）。

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_DIR } from './config.ts';
import { deduplicateByAncestry } from './paths.ts';
import { getLatestRunDir, getRunDir, listRunIds } from './runs.ts';
import { checkSchemaVersion, withSchema } from './types.ts';
import type { ScannedPath, Snapshot } from './types.ts';

/**
 * スキャン結果を Snapshot 形式に変換。
 */
export function buildSnapshot(
  scanned: ReadonlyArray<ScannedPath>,
  diskInfo: { totalBytes: number; freeBytes: number },
): Snapshot {
  const paths: Record<string, number> = {};
  for (const s of scanned) {
    paths[s.path] = s.sizeBytes;
  }
  return {
    timestamp: new Date().toISOString(),
    totalSizeBytes: diskInfo.totalBytes,
    freeSizeBytes: diskInfo.freeBytes,
    paths,
  };
}

/**
 * Snapshot を JSON 文字列にシリアライズ (schemaVersion 付き)。
 * 永続化は Run.writeFile() 経由。
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify(withSchema(snapshot), null, 2);
}

/**
 * 最新のスナップショットを読む。
 *
 * 探索順:
 *   1. runs/latest/snapshot.json（最も新しい run）
 *   2. 各 run/snapshot.json を新しい順に探索（latest にあっても snapshot 無いことあるため）
 *   3. レガシー SNAPSHOT_DIR/snapshot-*.json（旧データ）
 */
export async function loadLatestSnapshot(): Promise<Snapshot | null> {
  // 1. latest シンボリックリンク
  const latestDir = getLatestRunDir();
  if (latestDir) {
    const snap = await tryLoadSnapshot(join(latestDir, 'snapshot.json'));
    if (snap) return snap;
  }

  // 2. 全 run を新しい順に
  for (const id of listRunIds()) {
    const snap = await tryLoadSnapshot(join(getRunDir(id), 'snapshot.json'));
    if (snap) return snap;
  }

  // 3. レガシー
  if (existsSync(SNAPSHOT_DIR)) {
    const legacyFiles = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();
    const first = legacyFiles[0];
    if (first) {
      const snap = await tryLoadSnapshot(join(SNAPSHOT_DIR, first));
      if (snap) return snap;
    }
  }

  return null;
}

async function tryLoadSnapshot(path: string): Promise<Snapshot | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await Bun.file(path).text();
    const parsed = JSON.parse(content) as unknown;
    checkSchemaVersion(parsed, path);
    return parsed as Snapshot;
  } catch {
    return null;
  }
}

/**
 * 2つのスナップショットの差分を計算。
 */
export interface SnapshotDiff {
  readonly added: ReadonlyArray<{ path: string; sizeBytes: number }>;
  readonly removed: ReadonlyArray<{ path: string; sizeBytes: number }>;
  readonly grown: ReadonlyArray<{ path: string; oldSize: number; newSize: number; deltaBytes: number }>;
  readonly shrunk: ReadonlyArray<{ path: string; oldSize: number; newSize: number; deltaBytes: number }>;
  readonly freeBytesDelta: number;
}

export function diffSnapshots(prev: Snapshot, curr: Snapshot): SnapshotDiff {
  const added: Array<{ path: string; sizeBytes: number }> = [];
  const removed: Array<{ path: string; sizeBytes: number }> = [];
  const grown: Array<{ path: string; oldSize: number; newSize: number; deltaBytes: number }> = [];
  const shrunk: Array<{ path: string; oldSize: number; newSize: number; deltaBytes: number }> = [];

  const prevPaths = new Set(Object.keys(prev.paths));
  const currPaths = new Set(Object.keys(curr.paths));

  for (const p of currPaths) {
    if (!prevPaths.has(p)) {
      added.push({ path: p, sizeBytes: curr.paths[p] ?? 0 });
    } else {
      const oldSize = prev.paths[p] ?? 0;
      const newSize = curr.paths[p] ?? 0;
      const delta = newSize - oldSize;
      // 10% 以上の変化のみ追跡（ノイズ削減）
      const significant = Math.abs(delta) > Math.max(oldSize * 0.1, 50 * 1024 * 1024);
      if (delta > 0 && significant) grown.push({ path: p, oldSize, newSize, deltaBytes: delta });
      else if (delta < 0 && significant) shrunk.push({ path: p, oldSize, newSize, deltaBytes: delta });
    }
  }

  for (const p of prevPaths) {
    if (!currPaths.has(p)) {
      removed.push({ path: p, sizeBytes: prev.paths[p] ?? 0 });
    }
  }

  // 祖先のみへ畳む: du は階層ごとに行を出すため、1箇所の増減が親に全部足し上がって
  // 重複表示される（例: Notion 配下の +0.5GB が Notion/Partitions/notion/Service Worker の
  // 4階層に出る）。祖先を残し子孫を畳むことで実体1件に集約する（①② と同じ dedup）。
  return {
    added: deduplicateByAncestry(added).sort((a, b) => b.sizeBytes - a.sizeBytes),
    removed: deduplicateByAncestry(removed).sort((a, b) => b.sizeBytes - a.sizeBytes),
    grown: deduplicateByAncestry(grown).sort((a, b) => b.deltaBytes - a.deltaBytes),
    shrunk: deduplicateByAncestry(shrunk).sort((a, b) => a.deltaBytes - b.deltaBytes),
    freeBytesDelta: curr.freeSizeBytes - prev.freeSizeBytes,
  };
}
