// diffSnapshots のテスト。
//
// 焦点: grown/added の祖先重複排除（du が階層ごとに行を出すため、1箇所の増加が
// 親に全部足し上がって重複表示される問題。①② と同じ dedup ファミリー）。

import { describe, expect, it } from 'bun:test';
import { diffSnapshots } from '../src/snapshot.ts';
import type { Snapshot } from '../src/types.ts';

function snap(paths: Record<string, number>, freeSizeBytes = 50_000_000_000): Snapshot {
  return {
    timestamp: new Date(0).toISOString(),
    totalSizeBytes: 500_000_000_000,
    freeSizeBytes,
    paths,
  };
}

const G = 1_000_000_000;

describe('diffSnapshots ancestry dedup', () => {
  it('grown は祖先のみへ畳む（同じ増加を階層ごとに重複表示しない）', () => {
    // Notion 配下が一律 +0.52GB 増加 → du は全階層に出すが、実体は1箇所。
    const prev = snap({
      '/U/Library/Application Support/Notion': 4.66 * G,
      '/U/Library/Application Support/Notion/Partitions': 4.27 * G,
      '/U/Library/Application Support/Notion/Partitions/notion': 4.22 * G,
      '/U/Library/Application Support/Notion/Partitions/notion/Service Worker': 3.56 * G,
    });
    const curr = snap({
      '/U/Library/Application Support/Notion': 5.18 * G,
      '/U/Library/Application Support/Notion/Partitions': 4.79 * G,
      '/U/Library/Application Support/Notion/Partitions/notion': 4.74 * G,
      '/U/Library/Application Support/Notion/Partitions/notion/Service Worker': 4.08 * G,
    });
    const diff = diffSnapshots(prev, curr);
    // 祖先 Notion のみ残る（子3つは畳まれる）
    expect(diff.grown).toHaveLength(1);
    expect(diff.grown[0]?.path).toBe('/U/Library/Application Support/Notion');
  });

  it('added も祖先のみへ畳む', () => {
    const prev = snap({});
    const curr = snap({
      '/U/Library/Caches/NewApp': 3 * G,
      '/U/Library/Caches/NewApp/sub': 2 * G,
      '/U/Library/Caches/NewApp/sub/deep': 1 * G,
    });
    const diff = diffSnapshots(prev, curr);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.path).toBe('/U/Library/Caches/NewApp');
  });

  it('独立した（祖先関係にない）増加は両方残す', () => {
    const prev = snap({ '/U/Library/Caches/A': 1 * G, '/U/Library/Caches/B': 1 * G });
    const curr = snap({ '/U/Library/Caches/A': 2 * G, '/U/Library/Caches/B': 2 * G });
    const diff = diffSnapshots(prev, curr);
    expect(diff.grown).toHaveLength(2);
  });
});
