// レポート生成。ターミナル出力 + Markdown。
//
// ファイル書き込みは呼び出し側（Run.writeFile）に委譲。
// この層は純粋に文字列を生成するだけ（テスト容易性のため）。

import { formatBytes, HOME } from './config.ts';
import { deduplicateByAncestry } from './paths.ts';
import { withSchema } from './types.ts';
import type { Classification, ClassifiedPath, RegenCost } from './types.ts';
import type { SnapshotDiff } from './snapshot.ts';

/** CAREFUL を「♻️確認して消せる(regenerable)」と「📦残すデータ(実データ)」に分けた結果。 */
export interface CarefulSplit {
  readonly regenerable: ClassifiedPath[];
  readonly realData: ClassifiedPath[];
}

/**
 * CAREFUL を regenerable(再生成で戻る) と 実データ に分割する（2026-06-13 UX）。
 *
 * regenerable=true（CoreSimulator 等）は「確認して消せる」、それ以外（App Support 等の
 * アプリ実データ）は「残すデータ」。どちらも分類内 ancestry dedup 済・サイズ降順。
 * SAFE/DANGER/UNKNOWN は対象外。
 */
export function splitCarefulByRegenerable(
  classified: ReadonlyArray<ClassifiedPath>,
): CarefulSplit {
  const roots = deduplicateByAncestry(classified.filter((c) => c.classification === 'CAREFUL'));
  const bySize = (a: ClassifiedPath, b: ClassifiedPath) => b.sizeBytes - a.sizeBytes;
  return {
    regenerable: roots.filter((c) => c.regenerable === true).sort(bySize),
    realData: roots.filter((c) => c.regenerable !== true).sort(bySize),
  };
}

/** regenCost を「戻し方」の日本語ラベルにする。 */
function regenCostLabel(cost?: RegenCost): string {
  switch (cost) {
    case 'auto':
      return '自動で再生成される';
    case 'redownload':
      return '再ダウンロードで戻る';
    case 'rebuild':
      return '再ビルドで戻る';
    case 'reinstall':
      return '再インストールで戻る';
    default:
      return '再生成できる';
  }
}

interface ReportInput {
  readonly classified: ReadonlyArray<ClassifiedPath>;
  readonly diskInfo: { totalBytes: number; usedBytes: number; freeBytes: number };
  readonly diff?: SnapshotDiff | null;
  readonly timestamp?: Date;
  /** スキャンした対象ルート（絶対パス）。渡すと「Mac 全体でない」scope を明示する。 */
  readonly scanRoots?: ReadonlyArray<string>;
}

/** HOME を ~ に短縮して表示用に整える。 */
function abbreviateHome(path: string): string {
  return path.startsWith(HOME) ? '~' + path.slice(HOME.length) : path;
}

/**
 * ターミナル向け人間可読レポート（カラー無し、無地）。
 */
export function renderText(input: ReportInput): string {
  const { classified, diskInfo, diff } = input;
  const ts = (input.timestamp ?? new Date()).toLocaleString('ja-JP');

  // ancestry dedup 済の root のみで集計・表示（JSON サマリと一致させる）。
  // dedup なしの素の合計だと親と子を二重計上してしまう (例: Caches と Caches/Yarn)。
  const rootsByClass = dedupRootsByClass(classified);
  const safeTotal = sumSizeBytes(rootsByClass.SAFE);
  // ① UNKNOWN は残余（内包する分類済の子を引いた未分類残余）で表示し JSON サマリと一致させる
  const unknownTotal = unknownResidualBytes(
    rootsByClass.UNKNOWN,
    deduplicateByAncestry(classified.filter((c) => c.classification !== 'UNKNOWN')),
  );

  // CAREFUL を ♻️確認して消せる / 📦残すデータ に分割（友好ラベル表示）
  const careful = splitCarefulByRegenerable(classified);
  const regenCarefulTotal = sumSizeBytes(careful.regenerable);
  const realDataCarefulTotal = sumSizeBytes(careful.realData);

  const lines: string[] = [];
  lines.push(`📊 molt スキャン結果 - ${ts}`);
  lines.push('═'.repeat(60));
  lines.push('');
  // 絶対値表示 (% は APFS の purgeable/snapshot で実態とズレやすいため省く)
  // 単位は decimal GB (macOS UI と一致)。Used + Free = Total が目視確認できる。
  lines.push(`💾 使用: ${formatBytes(diskInfo.usedBytes)} / 実空き: ${formatBytes(diskInfo.freeBytes)} / 合計: ${formatBytes(diskInfo.totalBytes)}`);
  lines.push(`   ※実空きは purgeable(削除可能領域)を除く。ストレージ設定の「空き」より小さく出る`);
  if (diff) {
    const sign = diff.freeBytesDelta >= 0 ? '+' : '';
    lines.push(`   前回比: ${sign}${formatBytes(Math.abs(diff.freeBytesDelta))}`);
  }
  lines.push('');

  // scope を明示（全部見た結果と誤解させない）
  if (input.scanRoots && input.scanRoots.length > 0) {
    lines.push(`🔍 スキャン対象: ${input.scanRoots.map(abbreviateHome).join(', ')}`);
    lines.push('');
  }

  // 内部用語(SAFE/CAREFUL)を出さず「消せる/残す」で直感的に。アイコンで消していい度を示す
  lines.push(`🗑  すぐ消せる:      ${formatBytes(safeTotal).padStart(9)}   キャッシュ等・消しても自動で戻る`);
  lines.push(`♻️  確認して消せる:  ${formatBytes(regenCarefulTotal).padStart(9)}   再生成/再DLで戻る`);
  lines.push(`🔒  大事なデータ:    ${formatBytes(realDataCarefulTotal).padStart(9)}   消すとアプリ設定・データが飛ぶ`);
  lines.push(`❓  未判定:          ${formatBytes(unknownTotal).padStart(9)}   ルール未該当`);
  lines.push('');

  if (diff?.added && diff.added.length > 0) {
    lines.push('🆕 新規発見 (要レビュー):');
    for (const a of diff.added.slice(0, 10)) {
      lines.push(`   ${formatBytes(a.sizeBytes).padStart(10)}  ${a.path}`);
    }
    lines.push('');
  }

  if (diff?.grown && diff.grown.length > 0) {
    lines.push('📈 肥大化:');
    for (const g of diff.grown.slice(0, 10)) {
      lines.push(`   +${formatBytes(g.deltaBytes).padStart(9)}  ${g.path}  (→ ${formatBytes(g.newSize)})`);
    }
    lines.push('');
  }

  // 🗑 すぐ消せる
  appendItemList(lines, '🗑 すぐ消せる', rootsByClass.SAFE, (c) => c.reason);
  // ♻️ 確認して消せる（regenCost で戻し方を表示）
  appendItemList(lines, '♻️ 確認して消せる', careful.regenerable, (c) => regenCostLabel(c.regenCost), '消しても元に戻せる');
  // 🔒 大事なデータ（消すとまずい・安全案内付き）
  appendItemList(lines, '🔒 大事なデータ', careful.realData, (c) => c.reason, '消すとアプリ設定・データが飛ぶ・clean では消えません');
  // ❓ 未判定（② 残余化＋閾値で間引いた傘ノードのみ。空なら出さずサマリ行で担保）
  appendItemList(lines, '❓ 未判定', displayableUnknownRoots(classified), (c) => c.reason, undefined, true);

  lines.push('─'.repeat(60));
  lines.push('🗑 molt clean               すぐ消せるものをゴミ箱へ（大事なデータは消えません）');
  lines.push('♻️ molt clean --interactive   確認して消せるものを1件ずつ削除');
  lines.push('   molt empty-trash          ゴミ箱を空にして実際に解放');
  lines.push('   molt diff                 前回との差分');
  return lines.join('\n');
}

/**
 * 1グループの一覧をレポート行に追記する共有ヘルパー（renderText 用）。
 * 空グループはセクションごと省略。最大15件＋残数表示。
 *
 * @param noteAfterHeader 見出しに付ける補足（安全案内等）。任意。
 * @param subLine          各項目の2行目に出す説明（reason / regenCost ラベル等）。
 */
function appendItemList(
  lines: string[],
  heading: string,
  items: ReadonlyArray<ClassifiedPath>,
  subLine: (c: ClassifiedPath) => string,
  noteAfterHeader?: string,
  // ❓ UNKNOWN は ② で残余<閾値の傘ノードを意図的に隠す（teachable でないため）。
  // その場合だけ空セクションごと省く。削除系(🗑♻️🔒)は 0 件でも見出しを残す。
  suppressWhenEmpty = false,
): void {
  // 0 件でも見出しは残す（カテゴリが消えると「無い」のか「0」か分からないため）。
  if (items.length === 0) {
    if (suppressWhenEmpty) return;
    lines.push(`${heading} (0件) ── 該当なし`);
    lines.push('');
    return;
  }
  const note = noteAfterHeader ? ` ── ${noteAfterHeader}` : '';
  lines.push(`${heading} (${items.length}件)${note}:`);
  for (const c of items.slice(0, 15)) {
    lines.push(`   ${formatBytes(c.sizeBytes).padStart(10)}  ${c.path}`);
    lines.push(`              └ ${subLine(c)}`);
  }
  if (items.length > 15) {
    lines.push(`   ... 他 ${items.length - 15} 件`);
  }
  lines.push('');
}

/**
 * Markdown レポート（履歴保存用）。
 */
export function renderMarkdown(input: ReportInput): string {
  const { classified, diskInfo, diff } = input;
  const ts = (input.timestamp ?? new Date()).toISOString();

  // renderText と同じく dedup 済 root で集計・表示（二重計上を避ける）。
  const rootsByClass = dedupRootsByClass(classified);
  const safeTotal = sumSizeBytes(rootsByClass.SAFE);
  // ① UNKNOWN は残余で表示（renderText / JSON サマリと一致）
  const unknownTotal = unknownResidualBytes(
    rootsByClass.UNKNOWN,
    deduplicateByAncestry(classified.filter((c) => c.classification !== 'UNKNOWN')),
  );
  // CAREFUL を ♻️確認して消せる / 📦残すデータ に分割（renderText と同ラベル）
  const careful = splitCarefulByRegenerable(classified);

  const lines: string[] = [];
  lines.push(`# molt スキャン結果`);
  lines.push('');
  lines.push(`**生成**: ${ts}`);
  lines.push('');
  lines.push(`## ディスク状況`);
  lines.push('');
  lines.push(`| 項目 | 値 |`);
  lines.push(`|---|---|`);
  lines.push(`| 使用 | ${formatBytes(diskInfo.usedBytes)} |`);
  lines.push(`| 実空き (purgeable除く) | ${formatBytes(diskInfo.freeBytes)} |`);
  lines.push(`| 合計 | ${formatBytes(diskInfo.totalBytes)} |`);
  if (diff) {
    const sign = diff.freeBytesDelta >= 0 ? '+' : '-';
    lines.push(`| 前回比 | ${sign}${formatBytes(Math.abs(diff.freeBytesDelta))} |`);
  }
  lines.push('');
  if (input.scanRoots && input.scanRoots.length > 0) {
    lines.push(`> 🔍 スキャン対象: ${input.scanRoots.map(abbreviateHome).join(', ')}`);
    lines.push('');
  }
  lines.push(`## サマリー`);
  lines.push('');
  lines.push(`- 🗑 すぐ消せる: **${formatBytes(safeTotal)}**（キャッシュ等・自動で戻る）`);
  lines.push(`- ♻️ 確認して消せる: ${formatBytes(sumSizeBytes(careful.regenerable))}（再生成/再DLで戻る）`);
  lines.push(`- 🔒 大事なデータ: ${formatBytes(sumSizeBytes(careful.realData))}（消すとアプリ設定・データが飛ぶ）`);
  lines.push(`- ❓ 未判定: ${formatBytes(unknownTotal)}`);
  lines.push('');

  // 一覧（renderText と同じグルーピング・安全案内）
  appendMarkdownSection(lines, '🗑 すぐ消せる', rootsByClass.SAFE, (c) => c.reason);
  appendMarkdownSection(lines, '♻️ 確認して消せる（消しても元に戻せる）', careful.regenerable, (c) => regenCostLabel(c.regenCost));
  appendMarkdownSection(lines, '🔒 大事なデータ（消すと飛ぶ・clean では消えません）', careful.realData, (c) => c.reason);
  appendMarkdownSection(lines, '❓ 未判定', displayableUnknownRoots(classified), (c) => c.reason);

  return lines.join('\n');
}

/** renderMarkdown 用: 1グループのテーブルを追記。空ならセクションごと省略。 */
function appendMarkdownSection(
  lines: string[],
  heading: string,
  items: ReadonlyArray<ClassifiedPath>,
  subLine: (c: ClassifiedPath) => string,
): void {
  // 0 件でも見出しは残す（renderText と挙動を揃える）。
  if (items.length === 0) {
    lines.push(`## ${heading}`);
    lines.push('');
    lines.push('_該当なし_');
    lines.push('');
    return;
  }
  lines.push(`## ${heading}`);
  lines.push('');
  lines.push(`| サイズ | パス | 説明 |`);
  lines.push(`|---:|---|---|`);
  for (const c of items) {
    lines.push(`| ${formatBytes(c.sizeBytes)} | \`${c.path}\` | ${subLine(c)} |`);
  }
  lines.push('');
}

/**
 * 機械可読 JSON 形式のレポート (G3 --json フラグ用)。
 *
 * GUI / メニューバー / Swift 実装等の外部消費者向け。
 * `schemaVersion` 付き envelope で安定スキーマを保証 (G1)。
 *
 * @param extraFields runId, elapsedSeconds 等の追加情報を envelope に混ぜる
 */
export function renderJson(
  input: ReportInput,
  extraFields: Readonly<Record<string, unknown>> = {},
): string {
  const { classified, diskInfo, diff } = input;
  const timestamp = (input.timestamp ?? new Date()).toISOString();

  const summary = buildClassificationSummary(classified);

  return JSON.stringify(withSchema({
    type: 'scan-report',
    timestamp,
    diskInfo,
    scanRoots: input.scanRoots ?? null,
    summary,
    // B: skill が自前整形せず CLI と完全一致の人間可読サマリーを出せるよう、
    // renderText の出力をそのまま envelope に同梱（additive・案A・SCHEMA 据え置き）
    summaryText: renderText(input),
    classified: classified.map((c) => ({
      path: c.path,
      sizeBytes: c.sizeBytes,
      classification: c.classification,
      reason: c.reason,
      decidedBy: c.decidedBy,
      ruleName: c.ruleName,
      regenerable: c.regenerable,
      regenCost: c.regenCost,
    })),
    diff: diff ?? null,
    ...extraFields,
  }), null, 2);
}

/**
 * 分類別の件数・合計バイト数を集計 (renderJson のサマリ用)。
 *
 * ⚠️ ネストしたディレクトリ（親と子が両方 classified に含まれる）は、
 * 子のサイズが親に内包されるため単純合計すると二重計上になる
 * (例: ~/Library/Caches/Yarn 10GB と Yarn/v6 10GB を足して 20GB)。
 * そこで **分類ごとに祖先のみへ畳んでから** 集計し、実サイズに近づける。
 * dedup は分類内で行う（UNKNOWN 親に内包される SAFE 子は SAFE 側で残す）。
 *
 * immutable に処理 (in-place mutation を避ける、プロジェクト規約準拠)。
 */
export function buildClassificationSummary(
  classified: ReadonlyArray<ClassifiedPath>,
): Readonly<Record<Classification, { count: number; sizeBytes: number }>> {
  const classes: ReadonlyArray<Classification> = ['SAFE', 'CAREFUL', 'DANGER', 'UNKNOWN'];
  // ① 既知(分類済=非UNKNOWN)ルートを横断 ancestry dedup（cross-class の入れ子で二重減算しない）
  const knownRoots = deduplicateByAncestry(
    classified.filter((c) => c.classification !== 'UNKNOWN'),
  );
  return Object.fromEntries(
    classes.map((cls) => {
      const roots = deduplicateByAncestry(classified.filter((c) => c.classification === cls));
      // ① UNKNOWN は傘ノードから内包する既知の子を引いた「真の未分類残余」を出す
      const sizeBytes =
        cls === 'UNKNOWN'
          ? unknownResidualBytes(roots, knownRoots)
          : roots.reduce((s, c) => s + c.sizeBytes, 0);
      return [cls, { count: roots.length, sizeBytes }];
    }),
  ) as Record<Classification, { count: number; sizeBytes: number }>;
}

/**
 * UNKNOWN 傘ノード群から、内包する既知(分類済)ルートのサイズを引いた残余合計を返す（①）。
 *
 * 二重計上の排除: UNKNOWN `~/Library`(96GB) と その子 SAFE `Caches`(15GB) が
 * 両方カウントされる問題を、UNKNOWN 側を 96−15=81GB の残余にすることで解消する。
 * `knownRoots` は**横断 ancestry dedup 済**を渡すこと（CAREFUL 内に SAFE がネストする等の
 * 二重減算を防ぐ）。残余が負になり得る端は 0 で下駄を履かせる。
 */
function unknownResidualBytes(
  unknownRoots: ReadonlyArray<ClassifiedPath>,
  knownRoots: ReadonlyArray<ClassifiedPath>,
): number {
  return unknownRoots.reduce((total, u) => {
    const knownUnder = knownRoots.filter((k) => k.path.startsWith(u.path + '/'));
    const childSum = knownUnder.reduce((s, k) => s + k.sizeBytes, 0);
    return total + Math.max(0, u.sizeBytes - childSum);
  }, 0);
}

/** ④ 削除後の空き見込み = 現空き + 回収量。 */
export function projectedFreeBytes(currentFreeBytes: number, recoverableBytes: number): number {
  return currentFreeBytes + recoverableBytes;
}

/**
 * ④ clean --dry-run 用「回収後の空き見込み」行を生成する。
 *
 * ユーザー逐語要望「削除したら空きがどうなるか含めて」への対応。
 * trash モードは rename のみで実ディスクは未解放のため、empty-trash 注記を付ける
 * （ゴミ箱に移すだけでは空きが増えない、という誤解を防ぐ）。purge は即時解放。
 */
export function renderRecoveryProjection(opts: {
  currentFreeBytes: number;
  recoverableBytes: number;
  mode: 'trash' | 'purge';
}): string {
  const projected = projectedFreeBytes(opts.currentFreeBytes, opts.recoverableBytes);
  const line = `📊 回収後の空き見込み: ${formatBytes(opts.currentFreeBytes)} → ${formatBytes(projected)} (+${formatBytes(opts.recoverableBytes)})`;
  return opts.mode === 'trash'
    ? `${line}\n   ※ゴミ箱に移すだけでは未解放。molt empty-trash で確定`
    : line;
}

/**
 * ② これ未満の未分類残余を持つ UNKNOWN 傘ノードは一覧に出さない閾値。
 * scanRoot 丸ごと(~/Library 等)は teachable でなく、残余も小さくなりがちなのでノイズとして隠す。
 */
const UNKNOWN_DISPLAY_MIN_BYTES = 1_000_000_000; // 1GB

/**
 * 一覧表示用の UNKNOWN ルート（②）。
 *
 * 各 UNKNOWN 傘ノードのサイズを**残余**（内包する既知の子を引いた値）に置き換え、
 * 残余が {@link UNKNOWN_DISPLAY_MIN_BYTES} 未満のものを除外し、残余降順で返す。
 * これで「合計は残余なのに一覧は傘ノード満額」という食い違いを解消する。
 */
function displayableUnknownRoots(
  classified: ReadonlyArray<ClassifiedPath>,
): ClassifiedPath[] {
  const unknownRoots = deduplicateByAncestry(
    classified.filter((c) => c.classification === 'UNKNOWN'),
  );
  const knownRoots = deduplicateByAncestry(
    classified.filter((c) => c.classification !== 'UNKNOWN'),
  );
  return unknownRoots
    .map((u) => {
      const childSum = knownRoots
        .filter((k) => k.path.startsWith(u.path + '/'))
        .reduce((s, k) => s + k.sizeBytes, 0);
      return { ...u, sizeBytes: Math.max(0, u.sizeBytes - childSum) };
    })
    .filter((u) => u.sizeBytes >= UNKNOWN_DISPLAY_MIN_BYTES)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/** バイト合計（immutable reduce）。 */
function sumSizeBytes(items: ReadonlyArray<ClassifiedPath>): number {
  return items.reduce((s, c) => s + c.sizeBytes, 0);
}

/**
 * 表示用に分類ごと ancestry dedup した root 配列を返す。
 *
 * human-readable レポート (renderText/renderMarkdown) の合計・件数・一覧を
 * JSON サマリ (buildClassificationSummary) と一致させるための共有ヘルパー。
 * 親と子が両方 classified に含まれる場合、子は親に内包されるため root のみ残す
 * (二重計上の防止)。dedup は分類内で行う。
 */
function dedupRootsByClass(
  classified: ReadonlyArray<ClassifiedPath>,
): Readonly<Record<'SAFE' | 'CAREFUL' | 'UNKNOWN', ReadonlyArray<ClassifiedPath>>> {
  return {
    SAFE: deduplicateByAncestry(classified.filter((c) => c.classification === 'SAFE')),
    CAREFUL: deduplicateByAncestry(classified.filter((c) => c.classification === 'CAREFUL')),
    UNKNOWN: deduplicateByAncestry(classified.filter((c) => c.classification === 'UNKNOWN')),
  };
}
