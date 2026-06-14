// 分類器。ルール → ユーザー判定 → デフォルト の順で評価する。

import { applyBuiltinRules } from './rules.ts';
import type { ClassifiedPath, Decision, ScannedPath } from './types.ts';

/**
 * パスを分類する。
 *
 * 評価順:
 * 1. ユーザー判定（decisions.json）が完全一致 → 採用
 * 2. ユーザー判定が前方一致 → 採用
 * 3. 内蔵ルール → 採用
 * 4. デフォルト → UNKNOWN（手動レビュー対象）
 */
export function classify(
  scanned: ScannedPath,
  decisions: ReadonlyArray<Decision>,
): ClassifiedPath {
  // 1. ユーザー判定（完全一致）
  const exact = decisions.find((d) => d.path === scanned.path);
  if (exact) {
    return {
      ...scanned,
      classification: exact.classification,
      reason: exact.note ?? `ユーザー判定 (${exact.decidedAt.slice(0, 10)})`,
      decidedBy: 'user',
    };
  }

  // 2. ユーザー判定（前方一致）
  const prefix = decisions
    .filter((d) => scanned.path.startsWith(d.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (prefix) {
    return {
      ...scanned,
      classification: prefix.classification,
      reason: `親ディレクトリの判定を継承: ${prefix.path}`,
      decidedBy: 'user',
    };
  }

  // 3. 内蔵ルール
  const ruleMatch = applyBuiltinRules(scanned.path);
  if (ruleMatch) {
    // v0.2: ルール由来のみ regenerable/regenCost を伝播する。
    // user/prefix/default 分岐では付与しない（override は学習扱い・安全側）。
    return {
      ...scanned,
      classification: ruleMatch.classification,
      reason: ruleMatch.rule.reason,
      decidedBy: 'rule',
      ruleName: ruleMatch.rule.name,
      regenerable: ruleMatch.rule.regenerable,
      regenCost: ruleMatch.rule.regenCost,
    };
  }

  // 4. 未分類
  return {
    ...scanned,
    classification: 'UNKNOWN',
    reason: '内蔵ルールにも学習データにも該当なし',
    decidedBy: 'default',
  };
}

/**
 * 複数パスを一括分類。
 */
export function classifyAll(
  scanned: ReadonlyArray<ScannedPath>,
  decisions: ReadonlyArray<Decision>,
): ClassifiedPath[] {
  return scanned.map((s) => classify(s, decisions));
}
