// rules.ts のテスト。
//
// BUILTIN_RULES の各分類が期待通り動くことを保証する。
// 特に DANGER 系（誤削除でユーザーデータ消失）と新規追加ルールを重点的に。

import { describe, expect, it } from 'bun:test';
import { applyBuiltinRules, BUILTIN_RULES } from '../src/rules.ts';
import { HOME } from '../src/config.ts';

function classify(path: string): string | null {
  const r = applyBuiltinRules(path);
  return r ? r.classification : null;
}

function ruleName(path: string): string | null {
  const r = applyBuiltinRules(path);
  return r ? r.rule.name : null;
}

function regen(path: string): { regenerable?: boolean; regenCost?: string } | null {
  const r = applyBuiltinRules(path);
  return r ? { regenerable: r.rule.regenerable, regenCost: r.rule.regenCost } : null;
}

describe('DANGER rules (regression)', () => {
  it('~/.ssh は DANGER', () => {
    expect(classify(`${HOME}/.ssh`)).toBe('DANGER');
    expect(classify(`${HOME}/.ssh/id_rsa`)).toBe('DANGER');
  });

  it('~/.gnupg は DANGER', () => {
    expect(classify(`${HOME}/.gnupg`)).toBe('DANGER');
  });

  it('~/Library/Mail は DANGER', () => {
    expect(classify(`${HOME}/Library/Mail`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Mail/V10/Mailboxes`)).toBe('DANGER');
  });

  it('~/Library/Keychains は DANGER', () => {
    expect(classify(`${HOME}/Library/Keychains/login.keychain-db`)).toBe('DANGER');
  });

  it('Electron Cookies は DANGER（誤削除でサインアウト）', () => {
    expect(classify(`${HOME}/Library/Application Support/Notion/Cookies`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Slack/Cookies-journal`)).toBe('DANGER');
  });

  it('Electron Local Storage は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Cursor/Local Storage`)).toBe('DANGER');
  });
});

describe('SAFE rules (regression)', () => {
  it('Xcode DerivedData は SAFE', () => {
    expect(classify(`${HOME}/Library/Developer/Xcode/DerivedData/Foo-abc/Build`)).toBe('SAFE');
  });

  it('Electron Service Worker は SAFE（A1 で depth 6 化により拾える）', () => {
    expect(classify(`${HOME}/Library/Application Support/Notion/Service Worker/CacheStorage`)).toBe('SAFE');
  });

  it('Electron Code Cache は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Discord/Code Cache`)).toBe('SAFE');
  });
});

// ─────────────────────────────────────────
// C2: ~/Library/Fonts → DANGER
// ─────────────────────────────────────────
describe('C2: ~/Library/Fonts → DANGER', () => {
  it('~/Library/Fonts は DANGER', () => {
    expect(classify(`${HOME}/Library/Fonts`)).toBe('DANGER');
  });

  it('~/Library/Fonts 配下の個別フォントも DANGER', () => {
    expect(classify(`${HOME}/Library/Fonts/SourceCodePro-Regular.otf`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Fonts/MyFontFolder/foo.ttf`)).toBe('DANGER');
  });

  it('user-fonts ルール名で識別される', () => {
    expect(ruleName(`${HOME}/Library/Fonts/foo.ttf`)).toBe('user-fonts');
  });

  it('Library/FontCollections は誤マッチしない', () => {
    expect(ruleName(`${HOME}/Library/FontCollections/foo.collection`)).not.toBe('user-fonts');
  });
});

// ─────────────────────────────────────────
// C3: ~/.cache/uv, ~/.cache/pip → SAFE
// ─────────────────────────────────────────
describe('C3: ~/.cache/uv → SAFE', () => {
  it('~/.cache/uv は SAFE', () => {
    expect(classify(`${HOME}/.cache/uv`)).toBe('SAFE');
  });

  it('~/.cache/uv 配下の wheels も SAFE', () => {
    expect(classify(`${HOME}/.cache/uv/wheels-v1`)).toBe('SAFE');
    expect(classify(`${HOME}/.cache/uv/archive-v0/abc`)).toBe('SAFE');
  });

  it('uv-cache ルール名で識別される', () => {
    expect(ruleName(`${HOME}/.cache/uv`)).toBe('uv-cache');
  });

  it('~/.cache/uvicorn 等の prefix 衝突を起こさない', () => {
    expect(ruleName(`${HOME}/.cache/uvicorn`)).not.toBe('uv-cache');
  });
});

describe('C3: ~/.cache/pip → SAFE', () => {
  it('~/.cache/pip は SAFE', () => {
    expect(classify(`${HOME}/.cache/pip`)).toBe('SAFE');
  });

  it('~/.cache/pip/wheels も SAFE', () => {
    expect(classify(`${HOME}/.cache/pip/wheels/ab/cd/foo.whl`)).toBe('SAFE');
  });

  it('pip-cache ルール名で識別される', () => {
    expect(ruleName(`${HOME}/.cache/pip`)).toBe('pip-cache');
  });

  it('~/.cache/pipx (別物) は pip-cache にマッチしない', () => {
    expect(ruleName(`${HOME}/.cache/pipx`)).not.toBe('pip-cache');
  });
});

// ─────────────────────────────────────────
// B-1: Chrome / Brave / Edge を Electron ルールに統合
// パス構造:
//   Chrome: Application Support/Google/Chrome/{Default,Profile 1}/...
//   Brave:  Application Support/BraveSoftware/Brave-Browser/{Default}/...
//   Edge:   Application Support/Microsoft Edge/{Default}/...
// ─────────────────────────────────────────
describe('B-1: Chrome 系ブラウザ (DANGER)', () => {
  it('Chrome の Cookies は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Cookies`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Cookies-journal`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Profile 1/Cookies`)).toBe('DANGER');
  });

  it('Chrome の Local Storage は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Local Storage`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Local Storage/leveldb`)).toBe('DANGER');
  });

  it('Chrome の IndexedDB は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/IndexedDB`)).toBe('DANGER');
  });

  it('Brave (BraveSoftware/Brave-Browser) の Cookies は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies`)).toBe('DANGER');
  });

  it('Microsoft Edge の Cookies は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Microsoft Edge/Default/Cookies`)).toBe('DANGER');
  });
});

describe('B-1: Chrome 系ブラウザ (SAFE)', () => {
  it('Chrome の Service Worker は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Service Worker`)).toBe('SAFE');
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Service Worker/CacheStorage`)).toBe('SAFE');
  });

  it('Chrome の Cache は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Cache`)).toBe('SAFE');
  });

  it('Chrome の Code Cache は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/Code Cache`)).toBe('SAFE');
  });

  it('Chrome の GPUCache は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Default/GPUCache`)).toBe('SAFE');
  });

  it('Brave の Service Worker は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/BraveSoftware/Brave-Browser/Default/Service Worker`)).toBe('SAFE');
  });

  it('Edge の Cache は SAFE (2セグメント)', () => {
    expect(classify(`${HOME}/Library/Application Support/Microsoft Edge/Default/Cache`)).toBe('SAFE');
  });

  it('Edge の Service Worker は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Microsoft Edge/Default/Service Worker`)).toBe('SAFE');
  });

  it('Chrome Guest Profile の Cookies は DANGER', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/Guest Profile/Cookies`)).toBe('DANGER');
  });

  it('Chrome System Profile の Cache は SAFE', () => {
    expect(classify(`${HOME}/Library/Application Support/Google/Chrome/System Profile/Cache`)).toBe('SAFE');
  });
});

describe('B-1: 既存 Electron アプリのリグレッション（1セグメント構造）', () => {
  it('Notion (1 segment) はそのまま DANGER/SAFE 分類', () => {
    expect(classify(`${HOME}/Library/Application Support/Notion/Cookies`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Notion/Service Worker`)).toBe('SAFE');
  });

  it('Slack の Partitions 構造はそのまま動く', () => {
    expect(classify(`${HOME}/Library/Application Support/Slack/Partitions/abc123/Cookies`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Slack/Partitions/abc123/Service Worker`)).toBe('SAFE');
  });
});

describe('優先順位: DANGER は SAFE より先に評価される', () => {
  it('Electron Cookies (DANGER) が同階層の Service Worker (SAFE) より先に評価される', () => {
    // どちらも Application Support/<app> 配下だが、別パスなので衝突しない
    // ここでは「Cookies が DANGER として正しく拾われる」ことを再確認
    expect(classify(`${HOME}/Library/Application Support/Notion/Cookies`)).toBe('DANGER');
    expect(classify(`${HOME}/Library/Application Support/Notion/Service Worker`)).toBe('SAFE');
  });
});

// ─────────────────────────────────────────
// v0.2: regenerable / regenCost 付与
// ─────────────────────────────────────────
describe('v0.2: regenerable 付与 (パイプライン)', () => {
  it('Xcode DerivedData → regenerable=true / rebuild', () => {
    expect(regen(`${HOME}/Library/Developer/Xcode/DerivedData/Foo/Build`)).toEqual({ regenerable: true, regenCost: 'rebuild' });
  });

  it('各種 cache → regenerable=true / auto', () => {
    expect(regen(`${HOME}/Library/Caches/foo`)).toEqual({ regenerable: true, regenCost: 'auto' });
    expect(regen(`${HOME}/Library/Application Support/Notion/Service Worker`)).toEqual({ regenerable: true, regenCost: 'auto' });
  });

  it('パッケージマネージャ cache → regenerable=true / redownload', () => {
    expect(regen(`${HOME}/.npm`)).toEqual({ regenerable: true, regenCost: 'redownload' });
    expect(regen(`${HOME}/.cache/pip`)).toEqual({ regenerable: true, regenCost: 'redownload' });
  });

  it('iOS DeviceSupport → regenerable=true / auto (実機再接続)', () => {
    expect(regen(`${HOME}/Library/Developer/Xcode/iOS DeviceSupport/iPhone13,3 18.3`)).toEqual({ regenerable: true, regenCost: 'auto' });
  });

  it('CoreSimulator Devices → regenerable=true / reinstall', () => {
    expect(regen(`${HOME}/Library/Developer/CoreSimulator/Devices/ABC/data`)).toEqual({ regenerable: true, regenCost: 'reinstall' });
  });

  it('node_modules → regenerable=true / reinstall', () => {
    expect(regen(`${HOME}/work/foo/node_modules`)).toEqual({ regenerable: true, regenCost: 'reinstall' });
  });
});

describe('v0.2: android-system-image 新ルール', () => {
  it('Android system-images は CAREFUL + redownload', () => {
    const p = `${HOME}/Library/Android/sdk/system-images/android-34/google_apis_playstore/arm64-v8a`;
    expect(classify(p)).toBe('CAREFUL');
    expect(ruleName(p)).toBe('android-system-image');
    expect(regen(p)).toEqual({ regenerable: true, regenCost: 'redownload' });
  });

  it('~/.android/avd (ユーザー作成 AVD) は android-system-image にマッチしない', () => {
    // AVD はユニークなユーザー設定を含むため regenerable 対象外
    expect(ruleName(`${HOME}/.android/avd/Pixel_7.avd`)).not.toBe('android-system-image');
  });
});

describe('v0.2: 不変条件 — DANGER に regenerable は決して付かない', () => {
  const dangerPaths = [
    `${HOME}/.ssh/id_rsa`,
    `${HOME}/Library/Keychains/login.keychain-db`,
    `${HOME}/Library/Application Support/Google/Chrome/Default/Cookies`,
    `${HOME}/Library/Application Support/Notion/Local Storage`,
    `${HOME}/Documents/foo`,
    `${HOME}/Library/Mail`,
    `${HOME}/Library/Fonts/foo.ttf`,
  ];
  for (const p of dangerPaths) {
    it(`DANGER パスは regenerable!==true: ${p.replace(HOME, '~')}`, () => {
      expect(classify(p)).toBe('DANGER');
      expect(regen(p)?.regenerable).not.toBe(true);
    });
  }

  it('全 BUILTIN_RULES 走査: regenerable===true のルールは regenCost を持ち、その逆も成立 (整合性)', () => {
    for (const rule of BUILTIN_RULES) {
      if (rule.regenerable === true) {
        expect(rule.regenCost).toBeDefined();
      }
      if (rule.regenCost !== undefined) {
        expect(rule.regenerable).toBe(true);
      }
    }
  });

  it('regenerable=true のルール名は許可リストと完全一致 (DANGER ルールの混入を防ぐ)', () => {
    const allowed = [
      'xcode-derived-data', 'core-simulator-caches', 'caches-dir',
      'npm-cache', 'yarn-cache', 'pnpm-store', 'bun-cache', 'uv-cache', 'pip-cache',
      'electron-web-storage', 'electron-service-worker', 'electron-http-cache',
      'electron-code-cache', 'electron-gpu-cache', 'electron-crash-reports', 'electron-shared-dictionary',
      'xcode-ios-device-support', 'core-simulator-devices', 'node-modules', 'android-system-image',
    ].sort();
    const actual = BUILTIN_RULES.filter((r) => r.regenerable === true).map((r) => r.name).sort();
    expect(actual).toEqual(allowed);
  });
});

describe('マッチなし', () => {
  it('未知のパスは null', () => {
    expect(applyBuiltinRules(`${HOME}/SomeUnmatchedTopLevel/foo`)).toBeNull();
  });

  it('Documents 配下は projects も含め一律 DANGER（dev カーブアウト除去後）', () => {
    expect(classify(`${HOME}/Documents/projects/foo`)).toBe('DANGER');
    expect(classify(`${HOME}/Documents/projects/cleanup-mac`)).toBe('DANGER');
  });
});
