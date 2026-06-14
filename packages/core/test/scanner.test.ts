// scanner.ts のテスト。
//
// A1: 動的 depth 調整の pure helper `normalizeScanRoot` を検証。
// du の呼び出し本体はインテグレーションテストで（このユニットでは対象外）。

import { describe, expect, it } from 'bun:test';
import { MAX_SCAN_DEPTH, MIN_SCAN_DEPTH, normalizeScanRoot } from '../src/scanner.ts';

describe('normalizeScanRoot', () => {
  it('string 入力時は fallback depth を使う', () => {
    const result = normalizeScanRoot('/Users/foo/Library', 6);
    expect(result).toEqual({ path: '/Users/foo/Library', depth: 6 });
  });

  it('オブジェクト入力で depth 指定があればそれを使う', () => {
    const result = normalizeScanRoot(
      { path: '/Users/foo/.Trash', depth: 2 },
      6,
    );
    expect(result).toEqual({ path: '/Users/foo/.Trash', depth: 2 });
  });

  it('オブジェクト入力で depth 未指定なら fallback', () => {
    const result = normalizeScanRoot({ path: '/Users/foo/.cache' }, 4);
    expect(result).toEqual({ path: '/Users/foo/.cache', depth: 4 });
  });

  it('immutable: 入力オブジェクトを mutate しない', () => {
    const input = { path: '/Users/foo/.cache' } as const;
    normalizeScanRoot(input, 4);
    expect(input).toEqual({ path: '/Users/foo/.cache' });
  });

  it('MIN/MAX 境界値は受理する', () => {
    expect(normalizeScanRoot({ path: '/x', depth: MIN_SCAN_DEPTH }, 6).depth).toBe(MIN_SCAN_DEPTH);
    expect(normalizeScanRoot({ path: '/x', depth: MAX_SCAN_DEPTH }, 6).depth).toBe(MAX_SCAN_DEPTH);
  });

  it('depth=0 は throw する（サイレント機能不全防止）', () => {
    expect(() => normalizeScanRoot({ path: '/x', depth: 0 }, 6)).toThrow(RangeError);
  });

  it('depth が負値なら throw する', () => {
    expect(() => normalizeScanRoot({ path: '/x', depth: -1 }, 6)).toThrow(RangeError);
  });

  it('depth が上限超過なら throw する（巨大値防止）', () => {
    expect(() => normalizeScanRoot({ path: '/x', depth: MAX_SCAN_DEPTH + 1 }, 6))
      .toThrow(RangeError);
    expect(() => normalizeScanRoot({ path: '/x', depth: 999 }, 6)).toThrow(RangeError);
  });

  it('depth が非整数（NaN / 小数）なら throw する', () => {
    expect(() => normalizeScanRoot({ path: '/x', depth: 1.5 }, 6)).toThrow(RangeError);
    expect(() => normalizeScanRoot({ path: '/x', depth: Number.NaN }, 6)).toThrow(RangeError);
    expect(() => normalizeScanRoot({ path: '/x', depth: Number.POSITIVE_INFINITY }, 6))
      .toThrow(RangeError);
  });

  it('fallback depth が不正でも検証される（string 入力経路）', () => {
    expect(() => normalizeScanRoot('/Users/foo', 0)).toThrow(RangeError);
    expect(() => normalizeScanRoot('/Users/foo', 11)).toThrow(RangeError);
  });
});
