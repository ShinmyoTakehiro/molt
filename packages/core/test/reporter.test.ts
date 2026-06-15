// reporter.ts のテスト。
//
// G3 renderJson と buildClassificationSummary が安定スキーマで
// 出力することを保証。GUI / Swift 実装等の外部消費者の互換性に直結。

import { describe, expect, it } from 'bun:test';
import { buildClassificationSummary, renderJson, renderText, renderMarkdown, renderRecoveryProjection, projectedFreeBytes, splitCarefulByRegenerable } from '../src/reporter.ts';
import { formatBytes } from '../src/config.ts';
import { SCHEMA_VERSION } from '../src/types.ts';
import type { ClassifiedPath } from '../src/types.ts';

const fixtureClassified: ReadonlyArray<ClassifiedPath> = [
  {
    path: '/Users/foo/Library/Caches/npm',
    sizeBytes: 500_000_000,
    classification: 'SAFE',
    reason: 'npm キャッシュ',
    decidedBy: 'rule',
    ruleName: 'npm-cache',
  },
  {
    path: '/Users/foo/Library/Application Support/Notion',
    sizeBytes: 1_200_000_000,
    classification: 'CAREFUL',
    reason: 'アプリ別データ',
    decidedBy: 'rule',
    ruleName: 'application-support',
  },
  {
    path: '/Users/foo/.ssh',
    sizeBytes: 10_000,
    classification: 'DANGER',
    reason: 'SSH 鍵',
    decidedBy: 'rule',
    ruleName: 'ssh-keys',
  },
];

const fixtureDiskInfo = {
  totalBytes: 500_000_000_000,
  usedBytes: 300_000_000_000,
  freeBytes: 200_000_000_000,
};

// ♻️/📦 分割 + 友好ラベル (2026-06-13 UX 決定): CAREFUL を「♻️確認して消せる(regenerable)」と
// 「📦残すデータ(実データ)」に分け、内部用語(SAFE/CAREFUL)を隠した友好ラベルで出す。
const carefulSplitFixture: ReadonlyArray<ClassifiedPath> = [
  { path: '/Users/foo/Library/Developer/CoreSimulator/Devices', sizeBytes: 11_740_000_000, classification: 'CAREFUL', reason: 'iOS シミュレータ', decidedBy: 'rule', ruleName: 'core-simulator-devices', regenerable: true, regenCost: 'reinstall' },
  { path: '/Users/foo/Library/Developer/Xcode/iOS DeviceSupport', sizeBytes: 4_710_000_000, classification: 'CAREFUL', reason: 'iOS DeviceSupport', decidedBy: 'rule', ruleName: 'xcode-ios-device-support', regenerable: true, regenCost: 'auto' },
  { path: '/Users/foo/Library/Application Support', sizeBytes: 31_640_000_000, classification: 'CAREFUL', reason: 'アプリ別データ', decidedBy: 'rule', ruleName: 'application-support' },
  { path: '/Users/foo/Library/Group Containers', sizeBytes: 14_530_000_000, classification: 'CAREFUL', reason: 'アプリグループ共有データ', decidedBy: 'rule', ruleName: 'group-containers' },
  { path: '/Users/foo/Library/Caches/npm', sizeBytes: 16_000_000_000, classification: 'SAFE', reason: 'npm キャッシュ', decidedBy: 'rule', ruleName: 'npm-cache' },
];

describe('スキャン対象 (scope) の明示', () => {
  it('scanRoots を渡すと対象ディレクトリと「Mac 全体でない」注記を出す', () => {
    const txt = renderText({
      classified: [],
      diskInfo: fixtureDiskInfo,
      scanRoots: ['/Users/foo/Library', '/Users/foo/.cache', '/Users/foo/.Trash'],
    });
    expect(txt).toContain('スキャン対象');
    expect(txt).toContain('Library');
    expect(txt).toContain('.cache');
  });

  it('scanRoots 未指定なら scope 行は出さない（後方互換）', () => {
    const txt = renderText({ classified: [], diskInfo: fixtureDiskInfo });
    expect(txt).not.toContain('スキャン対象');
  });
});

describe('splitCarefulByRegenerable', () => {
  it('CAREFUL を regenerable(確認して消せる) と 実データ(残す) に分ける', () => {
    const { regenerable, realData } = splitCarefulByRegenerable(carefulSplitFixture);
    expect(regenerable.map((c) => c.ruleName)).toEqual(['core-simulator-devices', 'xcode-ios-device-support']); // size 降順
    expect(realData.map((c) => c.ruleName)).toEqual(['application-support', 'group-containers']);
  });

  it('SAFE/DANGER/UNKNOWN は混ぜない', () => {
    const { regenerable, realData } = splitCarefulByRegenerable(carefulSplitFixture);
    const all = [...regenerable, ...realData];
    expect(all.every((c) => c.classification === 'CAREFUL')).toBe(true);
  });
});

describe('renderText 友好ラベル + CAREFUL ♻️/🔒 分割', () => {
  it('内部用語でなく友好ラベルで出す', () => {
    const txt = renderText({ classified: carefulSplitFixture, diskInfo: fixtureDiskInfo });
    expect(txt).toContain('すぐ消せる');
    expect(txt).toContain('確認して消せる');
    expect(txt).toContain('大事なデータ');
  });

  it('regenerable CAREFUL は「確認して消せる」に、実データは「大事なデータ」に出す', () => {
    const txt = renderText({ classified: carefulSplitFixture, diskInfo: fixtureDiskInfo });
    const idxRegen = txt.indexOf('確認して消せる (2件)');
    const idxReal = txt.indexOf('大事なデータ (2件)');
    expect(idxRegen).toBeGreaterThan(-1);
    expect(idxReal).toBeGreaterThan(-1);
    // CoreSimulator は確認して消せる側、Application Support は大事なデータ側
    expect(txt).toContain('CoreSimulator/Devices');
    expect(txt).toContain('Application Support');
  });

  it('大事なデータに「消すと…飛ぶ」「clean では消えません」の安全案内を付ける', () => {
    const txt = renderText({ classified: carefulSplitFixture, diskInfo: fixtureDiskInfo });
    expect(txt).toContain('clean では消えません');
    expect(txt).toContain('飛ぶ'); // 消すとまずい感
  });

  it('該当0件の分類でも見出しを「(0件) 該当なし」で出す（カテゴリ消失を防ぐ）', () => {
    // SAFE のみ → ♻️/🔒/❓ は空。空でもステータス見出しは残す。
    const safeOnly: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library/Caches/npm', sizeBytes: 500_000_000, classification: 'SAFE', reason: 'npm', decidedBy: 'rule', ruleName: 'npm-cache' },
    ];
    const txt = renderText({ classified: safeOnly, diskInfo: fixtureDiskInfo });
    // 削除系 3 カテゴリ(🗑♻️🔒)は 0 件でも見出しを残す
    expect(txt).toContain('♻️ 確認して消せる (0件)');
    expect(txt).toContain('🔒 大事なデータ (0件)');
    expect(txt).toContain('該当なし');
    // ❓ UNKNOWN は ② の閾値抑制を維持（item list には出さず・サマリ行で担保）
    expect(txt).not.toContain('❓ 未判定 (0件)');
    expect(txt).toContain('未判定:'); // サマリ行は常に出る
  });
});

describe('renderJson summaryText (B 統一)', () => {
  it('envelope に summaryText があり renderText と一致する', () => {
    // timestamp を固定しないと両 render の時刻行がズレるため明示注入
    const input = { classified: carefulSplitFixture, diskInfo: fixtureDiskInfo, timestamp: new Date(0) };
    const parsed = JSON.parse(renderJson(input));
    expect(typeof parsed.summaryText).toBe('string');
    expect(parsed.summaryText).toBe(renderText(input));
  });
});

describe('buildClassificationSummary', () => {
  it('全 4 分類のバケツを返す (空でも 0/0)', () => {
    const summary = buildClassificationSummary([]);
    expect(Object.keys(summary).sort()).toEqual(['CAREFUL', 'DANGER', 'SAFE', 'UNKNOWN']);
    for (const k of ['SAFE', 'CAREFUL', 'DANGER', 'UNKNOWN'] as const) {
      expect(summary[k]).toEqual({ count: 0, sizeBytes: 0 });
    }
  });

  it('件数と合計バイト数を正しく集計する', () => {
    const summary = buildClassificationSummary(fixtureClassified);
    expect(summary.SAFE).toEqual({ count: 1, sizeBytes: 500_000_000 });
    expect(summary.CAREFUL).toEqual({ count: 1, sizeBytes: 1_200_000_000 });
    expect(summary.DANGER).toEqual({ count: 1, sizeBytes: 10_000 });
    expect(summary.UNKNOWN).toEqual({ count: 0, sizeBytes: 0 });
  });

  it('同一分類のネスト親子は二重計上せず祖先のみ集計する', () => {
    const nested: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library/Caches/Yarn', sizeBytes: 10_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
      { path: '/Users/foo/Library/Caches/Yarn/v6', sizeBytes: 10_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
      { path: '/Users/foo/Library/Caches/Yarn/v6/pkg', sizeBytes: 200_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
    ];
    // 子・孫は親 Yarn に内包されるので親のみ → 1 件 10GB
    expect(buildClassificationSummary(nested).SAFE).toEqual({ count: 1, sizeBytes: 10_000_000_000 });
  });

  // ① UNKNOWN 残余 (2026-06-12 UX 決定): UNKNOWN 傘ノードは内包する分類済の子を
  // 引いた「真の未分類残余」を出す。SAFE/CAREFUL/DANGER の数字は不変 (JSON 契約据え置き=案A)。
  // 旧挙動 (UNKNOWN 96GB と SAFE 15GB を両方カウント) は二重計上で混乱を生むため反転。
  it('① UNKNOWN 傘ノードは内包する分類済の子を引いた残余を出す', () => {
    const cross: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library', sizeBytes: 96_000_000_000, classification: 'UNKNOWN', reason: '未該当', decidedBy: 'default' },
      { path: '/Users/foo/Library/Caches', sizeBytes: 15_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
    ];
    const summary = buildClassificationSummary(cross);
    expect(summary.SAFE).toEqual({ count: 1, sizeBytes: 15_000_000_000 });   // 不変
    expect(summary.UNKNOWN).toEqual({ count: 1, sizeBytes: 81_000_000_000 }); // 96 − 15 = 残余
  });

  it('① 複数分類の子を横断 dedup して二重減算しない', () => {
    // CAREFUL の子に SAFE 孫がネスト → 既知を横断 dedup (外側 CAREFUL のみ) してから引く。
    // UNKNOWN 100 − CAREFUL 40 (SAFE 10 は CAREFUL 内包なので別途引かない) = 60。
    const nested: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library', sizeBytes: 100_000_000_000, classification: 'UNKNOWN', reason: '未該当', decidedBy: 'default' },
      { path: '/Users/foo/Library/App', sizeBytes: 40_000_000_000, classification: 'CAREFUL', reason: 'app', decidedBy: 'rule' },
      { path: '/Users/foo/Library/App/Cache', sizeBytes: 10_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
    ];
    const summary = buildClassificationSummary(nested);
    expect(summary.UNKNOWN.sizeBytes).toBe(60_000_000_000);
  });

  it('① 既知の子を持たない UNKNOWN は満額のまま', () => {
    const lone: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/.cache', sizeBytes: 650_000_000, classification: 'UNKNOWN', reason: '未該当', decidedBy: 'default' },
    ];
    expect(buildClassificationSummary(lone).UNKNOWN).toEqual({ count: 1, sizeBytes: 650_000_000 });
  });
});

// 回帰防止: human-readable (renderText/renderMarkdown) のサマリ合計が
// JSON (buildClassificationSummary) と同じく ancestry dedup 済であること。
// バグ: 親と子を素 reduce で足し二重計上していた (f914426 が JSON だけ修正・直し漏れ)。
const nestedSafe: ReadonlyArray<ClassifiedPath> = [
  { path: '/Users/foo/Library/Caches/Yarn', sizeBytes: 10_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
  { path: '/Users/foo/Library/Caches/Yarn/v6', sizeBytes: 10_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
  { path: '/Users/foo/Library/Caches/Yarn/v6/pkg', sizeBytes: 200_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
];

// ④ 投影空き容量 (2026-06-12 UX 決定・ユーザー逐語要望「削除したら空きがどうなるか含めて」):
// clean --dry-run の回収量から「削除後の空き見込み」を出す。
// trash モードは rename のみで未解放なので empty-trash 注記を付ける。
describe('④ 回収後の空き見込み (projection)', () => {
  it('projectedFreeBytes は 現空き + 回収量', () => {
    expect(projectedFreeBytes(51_200_000_000, 2_200_000_000)).toBe(53_400_000_000);
  });

  it('purge: 即時解放として「現空き → 投影」を出す（注記なし）', () => {
    const s = renderRecoveryProjection({
      currentFreeBytes: 51_200_000_000,
      recoverableBytes: 2_200_000_000,
      mode: 'purge',
    });
    expect(s).toContain('51.20GB');
    expect(s).toContain('53.40GB');
    expect(s).toContain('+2.20GB');
    expect(s).not.toContain('empty-trash');
  });

  it('trash: 未解放なので empty-trash 注記を付ける', () => {
    const s = renderRecoveryProjection({
      currentFreeBytes: 51_200_000_000,
      recoverableBytes: 2_200_000_000,
      mode: 'trash',
    });
    expect(s).toContain('53.40GB');
    expect(s).toContain('empty-trash'); // ゴミ箱を空にすると有効、の案内
  });

  it('回収量 0 でも壊れない（現空きのまま）', () => {
    expect(projectedFreeBytes(51_200_000_000, 0)).toBe(51_200_000_000);
  });
});

// ② UNKNOWN 傘ノード非表示 (2026-06-12 UX 決定): 残余<閾値(1GB)の UNKNOWN 傘ノードは
// 一覧から隠す（scanRoot 丸ごと=teachable でないため）。一覧に出る時は残余サイズで出す。
describe('② UNKNOWN 傘ノードの一覧表示', () => {
  it('残余が閾値未満の UNKNOWN 傘ノードは一覧に出さない', () => {
    // ~/Library 20GB の UNKNOWN だが子 SAFE 19.5GB で占有 → 残余 500MB(<1GB) → 隠す
    const covered: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library', sizeBytes: 20_000_000_000, classification: 'UNKNOWN', reason: '未該当', decidedBy: 'default' },
      { path: '/Users/foo/Library/Caches', sizeBytes: 19_500_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
    ];
    const txt = renderText({ classified: covered, diskInfo: fixtureDiskInfo });
    expect(txt).not.toContain('❓ 未判定 (');   // 一覧セクションが出ない
    expect(txt).toContain('未判定:');           // サマリ行は出す
    expect(txt).toContain('500.0MB');           // 残余合計
  });

  it('残余が閾値以上の UNKNOWN は残余サイズで一覧に出す', () => {
    // 残余 15GB(≥1GB) → 一覧に出す。傘の満額 20GB ではなく残余 15GB で
    const big: ReadonlyArray<ClassifiedPath> = [
      { path: '/Users/foo/Library', sizeBytes: 20_000_000_000, classification: 'UNKNOWN', reason: '未該当', decidedBy: 'default' },
      { path: '/Users/foo/Library/Caches', sizeBytes: 5_000_000_000, classification: 'SAFE', reason: 'cache', decidedBy: 'rule' },
    ];
    const txt = renderText({ classified: big, diskInfo: fixtureDiskInfo });
    expect(txt).toContain('❓ 未判定 (1件):');
    expect(txt).toContain('15.00GB  /Users/foo/Library'); // 満額 20GB でなく残余 15GB
    expect(txt).not.toContain('20.00GB');
  });
});

describe('renderText / renderMarkdown サマリは dedup 済 (JSON と一致)', () => {
  it('renderText: ネスト親子を二重計上しない (すぐ消せる=親のみ 10.00GB)', () => {
    const txt = renderText({ classified: nestedSafe, diskInfo: fixtureDiskInfo });
    expect(txt).toContain('すぐ消せる');               // 友好ラベル
    expect(txt).toContain('10.00GB');                  // 親のみ
    expect(txt).not.toContain('20.20GB');              // 二重計上値が出ない
    expect(txt).toContain('🗑 すぐ消せる (1件)');      // 件数も dedup
  });

  it('renderMarkdown: ネスト親子を二重計上しない (すぐ消せる=親のみ 10.00GB)', () => {
    const md = renderMarkdown({ classified: nestedSafe, diskInfo: fixtureDiskInfo });
    expect(md).toContain('🗑 すぐ消せる: **10.00GB**');
    expect(md).not.toContain('20.20GB');
  });

  it('renderText の すぐ消せる 合計は buildClassificationSummary と一致する', () => {
    const sum = buildClassificationSummary(nestedSafe);
    const txt = renderText({ classified: nestedSafe, diskInfo: fixtureDiskInfo });
    expect(txt).toContain('すぐ消せる');
    expect(txt).toContain(formatBytes(sum.SAFE.sizeBytes));
  });
});

describe('renderJson', () => {
  it('schemaVersion 付き envelope を出力する', () => {
    const json = renderJson({ classified: [], diskInfo: fixtureDiskInfo });
    const parsed = JSON.parse(json);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('type フィールドで scan-report と識別できる', () => {
    const json = renderJson({ classified: [], diskInfo: fixtureDiskInfo });
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('scan-report');
  });

  it('timestamp は ISO 8601 形式', () => {
    const json = renderJson({ classified: [], diskInfo: fixtureDiskInfo });
    const parsed = JSON.parse(json);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('diskInfo / summary / classified / diff を含む', () => {
    const json = renderJson({
      classified: fixtureClassified,
      diskInfo: fixtureDiskInfo,
    });
    const parsed = JSON.parse(json);
    expect(parsed.diskInfo).toEqual(fixtureDiskInfo);
    expect(parsed.summary.SAFE.count).toBe(1);
    expect(parsed.classified).toHaveLength(3);
    expect(parsed.diff).toBeNull();
  });

  it('classified の各エントリに必須フィールドが揃う', () => {
    const json = renderJson({
      classified: fixtureClassified,
      diskInfo: fixtureDiskInfo,
    });
    const parsed = JSON.parse(json);
    const first = parsed.classified[0];
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('sizeBytes');
    expect(first).toHaveProperty('classification');
    expect(first).toHaveProperty('reason');
    expect(first).toHaveProperty('decidedBy');
    expect(first).toHaveProperty('ruleName');
  });

  it('diff があれば envelope の diff に含める', () => {
    const diff = {
      added: [{ path: '/a', sizeBytes: 100 }],
      removed: [],
      grown: [],
      shrunk: [],
      freeBytesDelta: 100,
    };
    const json = renderJson({
      classified: [],
      diskInfo: fixtureDiskInfo,
      diff,
    });
    const parsed = JSON.parse(json);
    expect(parsed.diff).toEqual(diff);
  });

  it('出力は valid JSON (パース可能)', () => {
    const json = renderJson({
      classified: fixtureClassified,
      diskInfo: fixtureDiskInfo,
    });
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('v0.2: regenerable/regenCost を classified に含める', () => {
    const json = renderJson({
      classified: [
        { path: '/sim', sizeBytes: 100, classification: 'CAREFUL', reason: 'r', decidedBy: 'rule', regenerable: true, regenCost: 'reinstall' },
        { path: '/data', sizeBytes: 50, classification: 'CAREFUL', reason: 'r', decidedBy: 'rule' },
      ],
      diskInfo: fixtureDiskInfo,
    });
    const parsed = JSON.parse(json);
    expect(parsed.classified[0].regenerable).toBe(true);
    expect(parsed.classified[0].regenCost).toBe('reinstall');
    // 非 regenerable は欠落 or undefined（additive・後方互換）
    expect(parsed.classified[1].regenerable ?? undefined).toBeUndefined();
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION); // version は上げない
  });
});
