// config.ts のテスト。
//
// A1: scan 深度を 6 にアップ + 動的調整。
//   - DEFAULTS.scanDepth は 6（depth 5 にある Notion Service Worker 等を確実に拾う）
//   - DEFAULTS.scanRoots は string か ScanRoot オブジェクトの mix を許容
//   - 各 root に個別 depth を指定できる（Library=6, .Trash=2, .cache=4）

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { DEFAULTS, HOME, buildHardcodedExcludes, isExcluded } from '../src/config.ts';
import { normalizeScanRoot } from '../src/scanner.ts';

describe('DEFAULTS.scanDepth', () => {
  it('depth 5 にある Notion Service Worker 等を確実に拾うため 6 になっている', () => {
    expect(DEFAULTS.scanDepth).toBe(6);
  });
});

describe('DEFAULTS.scanRoots', () => {
  it('各 root に path + depth が含まれている', () => {
    for (const spec of DEFAULTS.scanRoots) {
      const normalized = normalizeScanRoot(spec, DEFAULTS.scanDepth);
      expect(typeof normalized.path).toBe('string');
      expect(normalized.path.length).toBeGreaterThan(0);
      expect(normalized.depth).toBeGreaterThanOrEqual(1);
      expect(normalized.depth).toBeLessThanOrEqual(10);
    }
  });

  it('~/Library は depth 6（深い Cache を拾う）', () => {
    const libraryPath = join(HOME, 'Library');
    const found = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth))
      .find((r) => r.path === libraryPath);
    expect(found).toBeDefined();
    expect(found?.depth).toBe(6);
  });

  it('~/.Trash は depth 2（フラット構造で十分）', () => {
    const trashPath = join(HOME, '.Trash');
    const found = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth))
      .find((r) => r.path === trashPath);
    expect(found).toBeDefined();
    expect(found?.depth).toBe(2);
  });

  it('~/.cache は depth 4', () => {
    const cachePath = join(HOME, '.cache');
    const found = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth))
      .find((r) => r.path === cachePath);
    expect(found).toBeDefined();
    expect(found?.depth).toBe(4);
  });
});

describe('buildHardcodedExcludes (配布安全性)', () => {
  const H = '/Users/test';
  const CFG = '/Users/test/.config/moltmac';
  const DATA = '/Users/test/.local/share/moltmac';

  it('ユーザーデータ・鍵・重要 Library を含む', () => {
    const ex = buildHardcodedExcludes(H, CFG, DATA);
    expect(ex).toContain('/Users/test/Documents');
    expect(ex).toContain('/Users/test/.ssh');
    expect(ex).toContain('/Users/test/Library/Keychains');
  });

  it('moltmac 自身のデータディレクトリを含む', () => {
    const ex = buildHardcodedExcludes(H, CFG, DATA);
    expect(ex).toContain(CFG);
    expect(ex).toContain(DATA);
  });

  it('dev 固有パス (~/Documents/projects/cleanup-mac) を焼き込まない', () => {
    const ex = buildHardcodedExcludes(H, CFG, DATA);
    expect(ex).not.toContain('/Users/test/Documents/projects/cleanup-mac');
  });

  it('selfHome 指定時のみ自己参照除外を追加し、未指定なら falsy を混入しない', () => {
    expect(buildHardcodedExcludes(H, CFG, DATA, '/opt/cleanup-mac')).toContain('/opt/cleanup-mac');
    const ex = buildHardcodedExcludes(H, CFG, DATA);
    expect(ex.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
  });

  it('空白のみの selfHome は無効値として追加しない', () => {
    const ex = buildHardcodedExcludes(H, CFG, DATA, '   ');
    expect(ex).not.toContain('   ');
    expect(ex.every((p) => p.trim().length > 0)).toBe(true);
  });
});

describe('isExcluded', () => {
  it('Documents 配下は除外される', () => {
    expect(isExcluded(join(HOME, 'Documents', 'secret.txt'))).toBe(true);
  });

  it('無関係な一時パスは除外されない', () => {
    expect(isExcluded('/tmp/some-random-cache-xyz')).toBe(false);
  });

  it('.. トラバーサルで保護領域に入るパスは除外される（正規化）', () => {
    // 生文字列で .. を含ませる（join は事前正規化してしまうため検証にならない）。
    // /Users/x/Library/Caches/../../Documents/secret → /Users/x/Documents/secret
    const traversal = `${HOME}/Library/Caches/../../Documents/secret`;
    expect(isExcluded(traversal)).toBe(true);
  });

  it('保護領域名の prefix 衝突は除外されない（.ssh-evil ≠ .ssh）', () => {
    // `.ssh` は除外だが `.ssh-evil` は別物。`excl + "/"` 比較で弾かれてはいけない
    expect(isExcluded(join(HOME, '.ssh-evil', 'data'))).toBe(false);
  });
});
