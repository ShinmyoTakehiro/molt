// ディスクスキャナ。du(1) を呼んでサイズを取得する。
//
// 自前で walk するより du の方が圧倒的に速い（C 実装、syscall 最適化）。

import { existsSync, statSync } from 'node:fs';
import { spawn } from 'bun';
import { DEFAULTS, isExcluded } from './config.ts';
import type { ScanOptions, ScanRootSpec, ScannedPath } from './types.ts';

/**
 * `ScanRootSpec` (string | {path, depth?}) を `{path, depth}` に正規化する。
 *
 * 動的 depth 調整の本体。各 root が個別の depth を持てるようにする。
 *
 * - string 入力: fallback depth を使う（後方互換）
 * - object 入力: `depth` 指定があればそれを使い、なければ fallback
 * - immutable: 入力オブジェクトを mutate しない（新規オブジェクトを返す）
 * - validate: depth は整数で {@link MIN_SCAN_DEPTH} <= depth <= {@link MAX_SCAN_DEPTH}
 *   範囲外/非整数なら throw。サイレントなスキャン失敗（depth=0 で結果ゼロ等）を防ぐ。
 *
 * @throws {RangeError} depth が範囲外または整数でない場合
 */
export function normalizeScanRoot(
  spec: ScanRootSpec,
  fallbackDepth: number,
): { readonly path: string; readonly depth: number } {
  const resolved = typeof spec === 'string'
    ? { path: spec, depth: fallbackDepth }
    : { path: spec.path, depth: spec.depth ?? fallbackDepth };

  validateDepth(resolved.depth, resolved.path);
  return resolved;
}

/** 最小スキャン深度（depth=0 はサイレント機能不全を起こすため禁止）*/
export const MIN_SCAN_DEPTH = 1;

/** 最大スキャン深度（巨大値で `~/Library` 配下を丸ごと列挙するのを防止）*/
export const MAX_SCAN_DEPTH = 10;

function validateDepth(depth: number, contextPath: string): void {
  if (!Number.isInteger(depth)) {
    throw new RangeError(
      `scan depth は整数である必要があります (got ${depth} for ${contextPath})`,
    );
  }
  if (depth < MIN_SCAN_DEPTH || depth > MAX_SCAN_DEPTH) {
    throw new RangeError(
      `scan depth は ${MIN_SCAN_DEPTH}..${MAX_SCAN_DEPTH} の範囲 (got ${depth} for ${contextPath})`,
    );
  }
}

/**
 * 単一ルートを du でスキャン。
 * 指定深度以下のディレクトリで minSizeBytes を超えるものを返す。
 */
async function scanRoot(
  root: string,
  depth: number,
  minSizeBytes: number,
  excludePaths: ReadonlyArray<string>,
): Promise<ScannedPath[]> {
  if (!existsSync(root)) return [];

  // du -d <depth> -k <root>: ブロックサイズ KB で出力
  const proc = spawn(['du', '-d', String(depth), '-k', root], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  const results: ScannedPath[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const sizeKbStr = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const sizeKb = Number.parseInt(sizeKbStr, 10);
    if (Number.isNaN(sizeKb)) continue;
    const sizeBytes = sizeKb * 1024;
    if (sizeBytes < minSizeBytes) continue;
    if (isExcluded(path)) continue;
    if (excludePaths.some((excl) => path === excl || path.startsWith(excl + '/'))) continue;

    // mtime を取得（ベストエフォート、失敗しても続行）
    let newestMtime: Date | undefined;
    try {
      newestMtime = statSync(path).mtime;
    } catch {
      // 権限不足等は無視
    }

    results.push({
      path,
      sizeBytes,
      ...(newestMtime ? { newestMtime } : {}),
    });
  }

  return results;
}

/**
 * 全ルートをスキャン。サイズ降順でソート済み。
 *
 * 各 root の depth は {@link normalizeScanRoot} で解決される。
 * - `options.roots` の各要素が string なら `options.depth` (or `DEFAULTS.scanDepth`) を使う
 * - object なら自身の `depth` を尊重、なければ fallback
 */
export async function scan(options: ScanOptions = {}): Promise<ScannedPath[]> {
  const roots = options.roots ?? DEFAULTS.scanRoots;
  const fallbackDepth = options.depth ?? DEFAULTS.scanDepth;
  const minSizeBytes = options.minSizeBytes ?? DEFAULTS.minSizeBytes;
  const excludePaths = options.excludePaths ?? [];

  const results: ScannedPath[] = [];
  for (const spec of roots) {
    const { path, depth } = normalizeScanRoot(spec, fallbackDepth);
    const rootResults = await scanRoot(path, depth, minSizeBytes, excludePaths);
    results.push(...rootResults);
  }

  // サイズ降順
  return results.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * 単一パスのサイズだけ取得（du -sk）。
 */
async function getPathSize(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const proc = spawn(['du', '-sk', path], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const line = stdout.trim().split('\n')[0];
  if (!line) return 0;
  const tabIdx = line.indexOf('\t');
  if (tabIdx === -1) return 0;
  const sizeKb = Number.parseInt(line.slice(0, tabIdx), 10);
  return Number.isNaN(sizeKb) ? 0 : sizeKb * 1024;
}

/**
 * 通常スキャンに、明示的に決定済みのパスを追加する。
 *
 * 背景: スキャンは root ごとの depth で実行する（既定: Library=6, .Trash=2, .cache=4）。
 * それより深い階層にユーザーが decide したパスは scan() の結果に含まれない。
 * このため classifier が決定を適用できず、削除候補にも出てこない。
 * → 決定済みパスのうち scan に含まれないものを個別に du -sk して追加。
 */
export async function expandWithDecisions(
  scanned: ReadonlyArray<ScannedPath>,
  decisionPaths: ReadonlyArray<string>,
): Promise<ScannedPath[]> {
  const known = new Set(scanned.map((s) => s.path));
  const additions: ScannedPath[] = [];
  for (const path of decisionPaths) {
    if (known.has(path)) continue;
    if (isExcluded(path)) continue;
    const sizeBytes = await getPathSize(path);
    if (sizeBytes === 0) continue;
    additions.push({ path, sizeBytes });
  }
  return [...scanned, ...additions].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * ディスク全体の容量情報。
 *
 * 重要: macOS APFS は単一 container を複数 volume (Data / System / VM / Preboot / Update)
 * が共有する。`df /System/Volumes/Data` は Data volume だけしか集計せず、System volume や
 * VM swap などが抜けて「About This Mac の Storage」の数字とズレる (典型 50-70 GB ズレ)。
 *
 * 対策: `diskutil apfs list` で container 全体の Size / In Use / Not Allocated を取得する。
 * 失敗時は df fallback (古い API、不完全だが取れないより良い)。
 */
export async function getDiskInfo(): Promise<{
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}> {
  try {
    return await getDiskInfoFromDiskutil();
  } catch {
    return await getDiskInfoFromDf();
  }
}

/** diskutil apfs list の出力から container 全体の容量を取得 */
async function getDiskInfoFromDiskutil(): Promise<{
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}> {
  const proc = spawn(['diskutil', 'apfs', 'list'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`diskutil apfs list exit ${proc.exitCode}`);
  }
  const stdout = await new Response(proc.stdout).text();
  // 内蔵 SSD の container を判定するのは複雑なので、最初に見つかったブロックを採用。
  // 通常は disk3 (Apple Silicon) または disk1 (Intel) が内蔵で最初に出る。
  const parsed = parseDiskutilApfsList(stdout);
  if (!parsed) {
    throw new Error('diskutil apfs list の解析失敗');
  }
  return parsed;
}

/**
 * diskutil apfs list の出力から container 全体の容量を抽出する pure helper。
 *
 * 期待形式:
 *   |   Size (Capacity Ceiling):      494332366848 B (494.3 GB)
 *   |   Capacity In Use By Volumes:   445919170560 B (445.9 GB) (90.2% used)
 *   |   Capacity Not Allocated:       48413196288 B (48.4 GB) (9.8% free)
 */
export function parseDiskutilApfsList(output: string): {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
} | null {
  const sizeMatch = output.match(/Size \(Capacity Ceiling\):\s+(\d+)\s+B/);
  const inUseMatch = output.match(/Capacity In Use By Volumes:\s+(\d+)\s+B/);
  const notAllocMatch = output.match(/Capacity Not Allocated:\s+(\d+)\s+B/);

  if (!sizeMatch || !inUseMatch || !notAllocMatch) return null;

  const totalBytes = Number.parseInt(sizeMatch[1] ?? '0', 10);
  const usedBytes = Number.parseInt(inUseMatch[1] ?? '0', 10);
  const freeBytes = Number.parseInt(notAllocMatch[1] ?? '0', 10);

  if (
    !Number.isFinite(totalBytes) || totalBytes <= 0 ||
    !Number.isFinite(usedBytes) || usedBytes < 0 ||
    !Number.isFinite(freeBytes) || freeBytes < 0
  ) {
    return null;
  }
  return { totalBytes, usedBytes, freeBytes };
}

/** df fallback (diskutil 失敗時、Data volume only — 不完全) */
async function getDiskInfoFromDf(): Promise<{
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}> {
  const proc = spawn(['df', '-k', '/System/Volumes/Data'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('df 出力が想定外: ' + stdout);
  }
  const dataLine = lines[1];
  if (!dataLine) {
    throw new Error('df 出力にデータ行なし');
  }
  const parts = dataLine.split(/\s+/);
  const totalKb = Number.parseInt(parts[1] ?? '0', 10);
  const usedKb = Number.parseInt(parts[2] ?? '0', 10);
  const freeKb = Number.parseInt(parts[3] ?? '0', 10);
  return {
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    freeBytes: freeKb * 1024,
  };
}
