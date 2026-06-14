// interactive review (v0.2)。
//
// regenerable な CAREFUL 項目を「1件ずつ削除に入れるか確認する」ための
// 候補抽出ロジック。CLI 層 (main.ts --interactive) から使う純粋関数。
// 副作用なし・テスト容易。

import { deduplicateByAncestry } from './paths.ts';
import type { ClassifiedPath, ScannedPath } from './types.ts';

/** 現役判定の既定閾値（cleaner.ts の年齢フィルタと同値）。 */
export const DEFAULT_AGE_THRESHOLD_DAYS = 7;

/** interactive review プロンプトの解釈結果。 */
export type ReviewAnswer = 'yes' | 'no' | 'all' | 'quit' | 'invalid';

/**
 * review プロンプト [y/N/a/q] の生入力を解釈する純粋関数。
 * 空入力・n は no（デフォルト N＝安全側）。未知入力は invalid（CLI 側で再入力を促す）。
 */
export function interpretReviewAnswer(raw: string): ReviewAnswer {
  const s = raw.trim().toLowerCase();
  if (s === 'y' || s === 'yes') return 'yes';
  if (s === '' || s === 'n' || s === 'no') return 'no';
  if (s === 'a' || s === 'all') return 'all';
  if (s === 'q' || s === 'quit') return 'quit';
  return 'invalid';
}

/**
 * interactive review の候補を抽出する。
 *
 * 対象は **CAREFUL かつ regenerable=true** のみ（SAFE は自動 clean 対象なので除外、
 * DANGER・非 regenerable な CAREFUL は提案しない）。
 * 親子は祖先のみへ畳み（二重提案防止）、サイズ降順で返す。
 *
 * @returns 提案順（大きい順）の候補リスト。immutable。
 */
export function selectReviewCandidates(
  classified: ReadonlyArray<ClassifiedPath>,
): ClassifiedPath[] {
  const candidates = classified.filter(
    (c) => c.classification === 'CAREFUL' && c.regenerable === true,
  );
  const roots = deduplicateByAncestry(candidates);
  return [...roots].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * 項目が「現役」(指定日数以内に更新された) か判定する。
 *
 * review で 🔥現役 ラベル + デフォルト N を出す根拠。cleaner.ts の年齢フィルタと
 * 同じ `newestMtime` 基準。`now` を明示注入できるようにしてテスト純度を保つ。
 *
 * @param item              判定対象（newestMtime を見る）
 * @param ageThresholdDays  この日数以内の更新を「現役」とみなす
 * @param now               基準時刻(ms)。既定は現在時刻
 */
export function isActive(
  item: ScannedPath,
  ageThresholdDays: number = DEFAULT_AGE_THRESHOLD_DAYS,
  now: number = Date.now(),
): boolean {
  if (!item.newestMtime) return false;
  const thresholdMs = ageThresholdDays * 24 * 60 * 60 * 1000;
  return now - item.newestMtime.getTime() < thresholdMs;
}
