// types.ts のテスト。
//
// v0.2 で regenerable / regenCost を additive 任意フィールドとして追加した際の
// 後方互換性を保証する。既存の永続化スキーマ (SCHEMA_VERSION=1) を壊さないこと。

import { describe, expect, it } from 'bun:test';
import { SCHEMA_VERSION, withSchema, checkSchemaVersion } from '../src/types.ts';
import type { ClassifiedPath, RegenCost } from '../src/types.ts';

describe('v0.2 regenerable フィールドの後方互換', () => {
  it('regenerable/regenCost を含むオブジェクトでも withSchema は version=1 を付与', () => {
    const wrapped = withSchema({ regenerable: true, regenCost: 'rebuild' as RegenCost });
    expect(wrapped.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1); // additive 追加で version は上げない
  });

  it('新フィールド付きでも checkSchemaVersion は version=1 を返す (warn なし)', () => {
    const parsed = { schemaVersion: 1, regenerable: true, regenCost: 'redownload' };
    expect(checkSchemaVersion(parsed, 'test')).toBe(1);
  });

  it('regenerable は任意 (未付与の ClassifiedPath が成立する)', () => {
    const legacy: ClassifiedPath = {
      path: '/x',
      sizeBytes: 100,
      classification: 'CAREFUL',
      reason: 'r',
      decidedBy: 'rule',
    };
    expect(legacy.regenerable).toBeUndefined();
    expect(legacy.regenCost).toBeUndefined();
  });
});
