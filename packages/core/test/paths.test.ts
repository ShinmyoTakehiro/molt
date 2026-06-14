// deduplicateByAncestry の pure テスト。

import { describe, expect, it } from 'bun:test';
import { deduplicateByAncestry } from '../src/paths.ts';

describe('deduplicateByAncestry', () => {
  it('子パスを除外し祖先のみ残す', () => {
    const items = [
      { path: '/a/b' },
      { path: '/a/b/c' },
      { path: '/a/b/c/d' },
    ];
    expect(deduplicateByAncestry(items)).toEqual([{ path: '/a/b' }]);
  });

  it('兄弟（祖先関係なし）は両方残す', () => {
    const items = [{ path: '/a/b' }, { path: '/a/c' }];
    expect(deduplicateByAncestry(items).map((x) => x.path).sort()).toEqual(['/a/b', '/a/c']);
  });

  it('prefix が似てるが祖先でないパスは残す (/a/b と /a/bb)', () => {
    const items = [{ path: '/a/b' }, { path: '/a/bb' }];
    expect(deduplicateByAncestry(items).map((x) => x.path).sort()).toEqual(['/a/b', '/a/bb']);
  });

  it('入力を破壊しない (immutable)', () => {
    const items = [{ path: '/a/b/c' }, { path: '/a/b' }];
    const copy = [...items];
    deduplicateByAncestry(items);
    expect(items).toEqual(copy);
  });

  it('空配列は空配列', () => {
    expect(deduplicateByAncestry([])).toEqual([]);
  });
});
