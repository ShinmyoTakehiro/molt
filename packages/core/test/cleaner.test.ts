// cleaner.ts のテスト。
//
// v0.2: selectTargetsByPaths — skill/interactive 両方が通る「特定パスだけ安全に消す」
// ターゲット選択の多層ガードを保証する。削除適格性に直結する核なので重点的に。

import { describe, expect, it } from 'bun:test';
import { selectTargetsByPaths } from '../src/cleaner.ts';
import { HOME } from '../src/config.ts';
import type { ClassifiedPath, Classification } from '../src/types.ts';

function cp(
  path: string,
  classification: Classification,
  extra: Partial<ClassifiedPath> = {},
): ClassifiedPath {
  return { path, sizeBytes: 100, classification, reason: 'r', decidedBy: 'rule', ...extra };
}

const SIM = `${HOME}/Library/Developer/CoreSimulator/Devices`;
const classified: ClassifiedPath[] = [
  cp(SIM, 'CAREFUL', { regenerable: true, regenCost: 'reinstall' }),
  cp(`${HOME}/Library/Caches/foo`, 'SAFE', { regenerable: true, regenCost: 'auto' }),
  cp(`${HOME}/Library/Application Support/Notion/Cookies`, 'DANGER'),
  cp(`${HOME}/Library/SomethingUnknown`, 'UNKNOWN'),
  cp(`${HOME}/Documents`, 'SAFE'), // 故意に SAFE 分類だが HARDCODED_EXCLUDES で弾かれるべき
  cp(`${HOME}/Library/Application Support/Foo`, 'CAREFUL'), // 非 regenerable な CAREFUL
];

describe('selectTargetsByPaths (ターゲット削除の多層ガード)', () => {
  it('存在する SAFE/CAREFUL は accept', () => {
    const r = selectTargetsByPaths(classified, [SIM]);
    expect(r.accepted.map((c) => c.path)).toEqual([SIM]);
    expect(r.rejected).toEqual([]);
  });

  it('scan 結果に無いパスは reject（捏造パス防止）', () => {
    const r = selectTargetsByPaths(classified, [`${HOME}/nonexistent`]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]?.path).toBe(`${HOME}/nonexistent`);
  });

  it('DANGER は reject', () => {
    const r = selectTargetsByPaths(classified, [`${HOME}/Library/Application Support/Notion/Cookies`]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('UNKNOWN は reject', () => {
    const r = selectTargetsByPaths(classified, [`${HOME}/Library/SomethingUnknown`]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('HARDCODED_EXCLUDES は分類が SAFE でも reject（多層防御）', () => {
    const r = selectTargetsByPaths(classified, [`${HOME}/Documents`]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('requireRegenerable=true で非 regenerable な CAREFUL を reject', () => {
    const r = selectTargetsByPaths(classified, [`${HOME}/Library/Application Support/Foo`], { requireRegenerable: true });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  it('accept/reject 混在を正しく振り分ける', () => {
    const r = selectTargetsByPaths(classified, [
      SIM,                                                   // accept
      `${HOME}/Library/Application Support/Notion/Cookies`,  // reject (DANGER)
      `${HOME}/ghost`,                                       // reject (不在)
    ]);
    expect(r.accepted.map((c) => c.path)).toEqual([SIM]);
    expect(r.rejected).toHaveLength(2);
  });
});
