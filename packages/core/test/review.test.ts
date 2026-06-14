// review.ts のテスト (v0.2)。
//
// interactive review の候補抽出ロジック。純粋関数なのでテスト容易。

import { describe, expect, it } from 'bun:test';
import { selectReviewCandidates, isActive, interpretReviewAnswer } from '../src/review.ts';
import type { ClassifiedPath } from '../src/types.ts';

function cp(partial: Partial<ClassifiedPath> & { path: string; sizeBytes: number }): ClassifiedPath {
  return {
    classification: 'CAREFUL',
    reason: 'r',
    decidedBy: 'rule',
    ...partial,
  };
}

describe('selectReviewCandidates', () => {
  it('CAREFUL かつ regenerable=true のみ抽出 (SAFE/DANGER/非regenerable CAREFUL は除外)', () => {
    const input: ClassifiedPath[] = [
      cp({ path: '/a/sim', sizeBytes: 100, classification: 'CAREFUL', regenerable: true, regenCost: 'reinstall' }),
      cp({ path: '/b/appsupport', sizeBytes: 999, classification: 'CAREFUL' }), // 非regenerable
      cp({ path: '/c/cache', sizeBytes: 500, classification: 'SAFE', regenerable: true }), // SAFE は対象外
      cp({ path: '/d/keychain', sizeBytes: 800, classification: 'DANGER' }),
    ];
    const out = selectReviewCandidates(input);
    expect(out.map((c) => c.path)).toEqual(['/a/sim']);
  });

  it('サイズ降順で返す', () => {
    const input: ClassifiedPath[] = [
      cp({ path: '/small', sizeBytes: 100, regenerable: true, regenCost: 'auto' }),
      cp({ path: '/big', sizeBytes: 9000, regenerable: true, regenCost: 'auto' }),
      cp({ path: '/mid', sizeBytes: 500, regenerable: true, regenCost: 'auto' }),
    ];
    expect(selectReviewCandidates(input).map((c) => c.path)).toEqual(['/big', '/mid', '/small']);
  });

  it('ネストした親子は祖先のみ (二重提案を防ぐ)', () => {
    const input: ClassifiedPath[] = [
      cp({ path: '/Devices', sizeBytes: 9000, regenerable: true, regenCost: 'reinstall' }),
      cp({ path: '/Devices/ABC/data', sizeBytes: 8000, regenerable: true, regenCost: 'reinstall' }),
    ];
    expect(selectReviewCandidates(input).map((c) => c.path)).toEqual(['/Devices']);
  });
});

describe('isActive (7日齢判定)', () => {
  const now = new Date('2026-06-11T00:00:00.000Z').getTime();
  const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000);

  it('7日以内に更新 → 現役 (true)', () => {
    expect(isActive(cp({ path: '/x', sizeBytes: 1, newestMtime: daysAgo(3) }), 7, now)).toBe(true);
  });

  it('7日より前 → 非現役 (false)', () => {
    expect(isActive(cp({ path: '/x', sizeBytes: 1, newestMtime: daysAgo(30) }), 7, now)).toBe(false);
  });

  it('mtime 不明 → 非現役 (false)', () => {
    expect(isActive(cp({ path: '/x', sizeBytes: 1 }), 7, now)).toBe(false);
  });
});

describe('interpretReviewAnswer', () => {
  it('y / yes → yes', () => {
    expect(interpretReviewAnswer('y')).toBe('yes');
    expect(interpretReviewAnswer('YES')).toBe('yes');
  });
  it('空 / n / no → no (デフォルト N・安全側)', () => {
    expect(interpretReviewAnswer('')).toBe('no');
    expect(interpretReviewAnswer('n')).toBe('no');
    expect(interpretReviewAnswer('  No ')).toBe('no');
  });
  it('a / all → all、q / quit → quit', () => {
    expect(interpretReviewAnswer('a')).toBe('all');
    expect(interpretReviewAnswer('q')).toBe('quit');
  });
  it('未知入力 → invalid', () => {
    expect(interpretReviewAnswer('x')).toBe('invalid');
  });
});
