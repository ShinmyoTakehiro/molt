// classifier.ts のテスト。
//
// v0.2: ルール由来の regenerable/regenCost が ClassifiedPath に伝播すること、
// かつ user/prefix/default 分岐では付与されない（安全側）ことを保証する。

import { describe, expect, it } from 'bun:test';
import { classify } from '../src/classifier.ts';
import { HOME } from '../src/config.ts';
import type { Decision, ScannedPath } from '../src/types.ts';

function scanned(path: string): ScannedPath {
  return { path, sizeBytes: 1_000_000 };
}

describe('v0.2: classifier の regenerable 伝播', () => {
  it('ルール由来 (DerivedData) は regenerable/regenCost を伝播', () => {
    const c = classify(scanned(`${HOME}/Library/Developer/Xcode/DerivedData/Foo`), []);
    expect(c.classification).toBe('SAFE');
    expect(c.regenerable).toBe(true);
    expect(c.regenCost).toBe('rebuild');
  });

  it('ルール由来 (CoreSimulator Devices) は CAREFUL + reinstall', () => {
    const c = classify(scanned(`${HOME}/Library/Developer/CoreSimulator/Devices/ABC`), []);
    expect(c.classification).toBe('CAREFUL');
    expect(c.regenerable).toBe(true);
    expect(c.regenCost).toBe('reinstall');
  });

  it('DANGER (keychain) は regenerable 未付与', () => {
    const c = classify(scanned(`${HOME}/Library/Keychains/login.keychain-db`), []);
    expect(c.classification).toBe('DANGER');
    expect(c.regenerable).toBeUndefined();
    expect(c.regenCost).toBeUndefined();
  });

  it('ユーザー判定 (完全一致 override) は regenerable を付けない（安全側）', () => {
    // 本来 regenerable なパスでも、user override は学習扱いで regenerable を伝播しない
    const decisions: Decision[] = [{
      path: `${HOME}/Library/Developer/Xcode/DerivedData/Foo`,
      classification: 'SAFE',
      decidedAt: '2026-06-11T00:00:00.000Z',
      decidedBy: 'user',
      source: 'user',
    }];
    const c = classify(scanned(`${HOME}/Library/Developer/Xcode/DerivedData/Foo`), decisions);
    expect(c.decidedBy).toBe('user');
    expect(c.regenerable).toBeUndefined();
  });

  it('UNKNOWN は regenerable 未付与', () => {
    const c = classify(scanned(`${HOME}/Library/SomethingUnmatched`), []);
    expect(c.classification).toBe('UNKNOWN');
    expect(c.regenerable).toBeUndefined();
  });
});
