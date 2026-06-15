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

  // C1: dev ビルドツール cache を「cache サブディレクトリ直接」で scan 対象化する。
  // 親 (~/.gradle 等) を root にすると兄弟の実体 (jdks / bin / settings.xml) を
  // 走査してしまうため、cache サブディレクトリだけを root にして走査面を最小化する。
  it('C1: ~/.gradle/caches を cache サブディレクトリ直接で含む（親 ~/.gradle は含まない）', () => {
    const paths = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth).path);
    expect(paths).toContain(join(HOME, '.gradle', 'caches'));
    expect(paths).not.toContain(join(HOME, '.gradle'));
  });

  it('C1: ~/.m2/repository を含む（親 ~/.m2 は含まない＝settings.xml を走査しない）', () => {
    const paths = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth).path);
    expect(paths).toContain(join(HOME, '.m2', 'repository'));
    expect(paths).not.toContain(join(HOME, '.m2'));
  });

  it('C1: ~/.cargo/registry と /git を含む（親 ~/.cargo は含まない＝bin を走査しない）', () => {
    const paths = DEFAULTS.scanRoots
      .map((spec) => normalizeScanRoot(spec, DEFAULTS.scanDepth).path);
    expect(paths).toContain(join(HOME, '.cargo', 'registry'));
    expect(paths).toContain(join(HOME, '.cargo', 'git'));
    expect(paths).not.toContain(join(HOME, '.cargo'));
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

  // C1: cargo cache を scan 対象化するにあたり、兄弟の ~/.cargo/bin
  // (cargo install したバイナリ本体) を多層防御で保護する。走査面外なので
  // 通常は触れないが、手動 --paths でも削除を拒否する硬い壁を追加する。
  it('C1: ~/.cargo/bin (インストール済バイナリ) は手動指定でも除外される', () => {
    expect(isExcluded(join(HOME, '.cargo', 'bin'))).toBe(true);
    expect(isExcluded(join(HOME, '.cargo', 'bin', 'ripgrep'))).toBe(true);
  });

  // 監査 LOW-1: Maven 認証情報を多層防御で保護（走査面外だが手動指定をフェールセーフ拒否）
  it('C1: ~/.m2/settings.xml と settings-security.xml (認証情報) は手動指定でも除外される', () => {
    expect(isExcluded(join(HOME, '.m2', 'settings.xml'))).toBe(true);
    expect(isExcluded(join(HOME, '.m2', 'settings-security.xml'))).toBe(true);
  });
});
