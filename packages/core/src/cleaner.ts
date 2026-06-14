// クリーナー。SAFE 判定パスをゴミ箱へ移動 or 完全削除する。
//
// 安全装置:
//   - デフォルトはゴミ箱経由（30 日後 OS が自動削除）
//   - HARDCODED_EXCLUDES に該当するパスは多重チェックで弾く
//   - dryRun=true なら実際には触らない
//   - 7 日以内に変更されたファイルが含まれる場合はスキップ（年齢フィルタ）
//   - DANGER / UNKNOWN は対象外（デフォルト）

import { mkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun';
import { TRASH_DIR, isExcluded } from './config.ts';
import { deduplicateByAncestry } from './paths.ts';
import { withSchema } from './types.ts';
import type { CleanOptions, CleanupLog, ClassifiedPath } from './types.ts';

const DEFAULT_TARGETS: ReadonlyArray<'SAFE' | 'CAREFUL' | 'DANGER' | 'UNKNOWN'> = ['SAFE'];
const DEFAULT_AGE_THRESHOLD_DAYS = 7;

/**
 * 分類済みパスを評価し、削除候補を抽出する。
 * 実削除は execute() で行う。
 *
 * 重要: du は depth 0..N の全階層を返すため、親と子を両方含む。
 * そのままだと mv 時に重複エラー、サイズ集計も水増し。
 * 祖先パスが既に対象に含まれる場合は子を除外する。
 */
export function selectTargets(
  classified: ReadonlyArray<ClassifiedPath>,
  options: CleanOptions = {},
): ClassifiedPath[] {
  const targets = options.classifications ?? DEFAULT_TARGETS;
  const ageThresholdDays = options.ageThresholdDays ?? DEFAULT_AGE_THRESHOLD_DAYS;
  const ageThresholdMs = ageThresholdDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const filtered = classified.filter((c) => {
    if (!targets.includes(c.classification)) return false;
    if (isExcluded(c.path)) return false;
    if (c.newestMtime && now - c.newestMtime.getTime() < ageThresholdMs) return false;
    return true;
  });

  return deduplicateByAncestry(filtered);
}

/** selectTargetsByPaths の戻り値。accepted=削除して良い / rejected=理由付きで除外。 */
export interface PathSelectionResult {
  readonly accepted: ClassifiedPath[];
  readonly rejected: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * 指定パスだけを削除対象に選ぶ（v0.2）。
 *
 * skill の会話レビュー（承認パスを渡す）と interactive の両方が通る、
 * **「特定パスを安全に消す」ロジックの単一の集約点**。任意パスを受けるため
 * 多層ガードで検証し、1つでも外れたパスは削除せず理由付きで rejected に回す:
 *   1. scan 結果に実在するか（捏造パス防止）
 *   2. 分類が SAFE / CAREFUL のみ（DANGER / UNKNOWN は拒否）
 *   3. HARDCODED_EXCLUDES に当たらない（isExcluded 多層防御）
 *   4. requireRegenerable 指定時は regenerable=true のみ
 *
 * 注: 年齢フィルタは**かけない**。本関数に渡る時点でユーザーが明示承認済みのため
 * （interactive の現役二段確認 / skill の会話承認）。最終 isExcluded は execute() でも再チェック。
 *
 * @param classified  scan→classify 済みの全パス
 * @param paths       削除したい絶対パス
 * @param opts        requireRegenerable: regenerable=true 以外を弾く（review 用途）
 */
export function selectTargetsByPaths(
  classified: ReadonlyArray<ClassifiedPath>,
  paths: ReadonlyArray<string>,
  opts: { readonly requireRegenerable?: boolean } = {},
): PathSelectionResult {
  const byPath = new Map(classified.map((c) => [c.path, c]));
  const accepted: ClassifiedPath[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const path of paths) {
    const c = byPath.get(path);
    if (!c) {
      rejected.push({ path, reason: 'スキャン結果に存在しない（古い/誤ったパス）' });
      continue;
    }
    if (c.classification === 'DANGER') {
      rejected.push({ path, reason: 'DANGER（保護対象・削除不可）' });
      continue;
    }
    if (c.classification === 'UNKNOWN') {
      rejected.push({ path, reason: 'UNKNOWN（未分類・削除には手動判定が必要）' });
      continue;
    }
    if (isExcluded(path)) {
      rejected.push({ path, reason: '保護領域（HARDCODED_EXCLUDES）' });
      continue;
    }
    if (opts.requireRegenerable && c.regenerable !== true) {
      rejected.push({ path, reason: 'regenerable でない（再生成不可の可能性）' });
      continue;
    }
    accepted.push(c);
  }

  return { accepted: deduplicateByAncestry(accepted), rejected };
}

/**
 * 削除実行（または dry-run）。
 * 戻り値はログ。永続化は writeLog() を別途呼ぶ。
 */
export async function execute(
  targets: ReadonlyArray<ClassifiedPath>,
  options: CleanOptions = {},
): Promise<CleanupLog> {
  const dryRun = options.dryRun ?? false;
  const purge = options.purge ?? false;
  const mode: 'trash' | 'purge' = purge ? 'purge' : 'trash';
  const timestamp = new Date().toISOString();

  const entries: Array<{
    path: string;
    sizeBytes: number;
    result: 'success' | 'skipped' | 'error';
    errorMessage?: string;
  }> = [];
  let totalFreedBytes = 0;

  for (const t of targets) {
    // 念のため最終チェック
    if (isExcluded(t.path)) {
      entries.push({
        path: t.path,
        sizeBytes: t.sizeBytes,
        result: 'skipped',
        errorMessage: 'HARDCODED_EXCLUDES に該当（最終チェックで拒否）',
      });
      continue;
    }

    if (dryRun) {
      entries.push({ path: t.path, sizeBytes: t.sizeBytes, result: 'success' });
      totalFreedBytes += t.sizeBytes;
      continue;
    }

    try {
      if (purge) {
        await purgePath(t.path);
      } else {
        await trashPath(t.path);
      }
      entries.push({ path: t.path, sizeBytes: t.sizeBytes, result: 'success' });
      totalFreedBytes += t.sizeBytes;
    } catch (e) {
      entries.push({
        path: t.path,
        sizeBytes: t.sizeBytes,
        result: 'error',
        errorMessage: (e as Error).message,
      });
    }
  }

  return { timestamp, mode, entries, totalFreedBytes };
}

/**
 * パスをゴミ箱へ移動。同名衝突時はタイムスタンプ付与。
 *
 * macOS のシステム保護ディレクトリ（~/Library/Logs など）はディレクトリ自体を
 * mv できない場合があるので、Permission denied 時は中身だけ移動するフォールバック。
 */
async function trashPath(path: string): Promise<void> {
  await mkdir(TRASH_DIR, { recursive: true });
  const baseName = path.split('/').pop() ?? 'unknown';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(TRASH_DIR, `${baseName}.${ts}`);

  const proc = spawn(['mv', path, dest], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  if (proc.exitCode === 0) return;

  const stderr = await new Response(proc.stderr).text();

  // Permission denied → ディレクトリ内の子要素を個別に移動（フォールバック）
  if (stderr.includes('Permission denied')) {
    const moved = await trashChildren(path, dest);
    if (moved > 0) return;
  }

  throw new Error(`mv 失敗: ${stderr.trim()}`);
}

/**
 * ディレクトリ自体は触らず、中身を全てゴミ箱へ。
 * システム保護ディレクトリ用のフォールバック。
 */
async function trashChildren(srcDir: string, destBase: string): Promise<number> {
  await mkdir(destBase, { recursive: true });
  // `ls -A` のパース（改行含みファイル名で壊れる）でなく readdirSync を使う。
  // 改行や特殊文字を含むファイル名も正確に列挙でき、shell も介さない（H-1 修正）。
  let children: string[];
  try {
    children = readdirSync(srcDir); // . / .. は含まれない（ls -A 相当）
  } catch {
    return 0; // 読めない（権限等）なら何も移動しない
  }
  let moved = 0;
  for (const name of children) {
    const childSrc = join(srcDir, name);
    // 防御深化: フォールバック経路でも除外領域 (HARDCODED_EXCLUDES) は絶対に触らない
    if (isExcluded(childSrc)) continue;
    const childDest = join(destBase, name);
    const proc = spawn(['mv', childSrc, childDest], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    if (proc.exitCode === 0) moved++;
  }
  return moved;
}

/**
 * 完全削除（rm -rf）。--purge 指定時のみ。
 */
async function purgePath(path: string): Promise<void> {
  const proc = spawn(['rm', '-rf', path], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`rm 失敗: ${stderr.trim()}`);
  }
}

/**
 * ログを JSON 文字列にシリアライズする (schemaVersion 付き)。
 * 実際の永続化は呼び出し側（Run.writeFile()）で行う。
 */
export function serializeLog(log: CleanupLog): string {
  return JSON.stringify(withSchema(log), null, 2);
}
