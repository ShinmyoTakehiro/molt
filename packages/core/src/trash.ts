// ゴミ箱を空にするユーティリティ。
//
// 背景: APFS 同一ボリュームでは mv はメタデータ更新のみで、実際にディスク
// を解放するにはゴミ箱を空にする必要がある。CLI から安全に空にする手段を提供。
//
// 安全装置:
//   - dryRun=true なら触らない
//   - 削除は osascript 経由 (Finder に委譲) → macOS のロックファイル / .DS_Store 等の
//     特殊扱いを尊重し、Trash の内部整合性を壊さない
//   - osascript 失敗時は明示エラー (fallback の rm はあえて行わない)

import { existsSync } from 'node:fs';
import { spawn } from 'bun';
import { TRASH_DIR } from './config.ts';

/** ゴミ箱の現在状態 */
export interface TrashContents {
  readonly path: string;
  readonly sizeBytes: number;
  readonly itemCount: number;
  /**
   * ゴミ箱の中身を読めたか。
   * macOS の TCC (Full Disk Access 未許可) 等で `du`/`ls` が権限拒否されると false。
   * false の時 sizeBytes/itemCount は 0 だが「空」ではなく「不明」を意味する。
   */
  readonly accessible: boolean;
}

/** emptyTrash() の結果 */
export interface EmptyTrashResult {
  readonly success: boolean;
  /**
   * - `osascript`: Finder 経由で実削除した
   * - `dry-run`: dryRun=true のため何もしていない (削除予定サイズだけ freedBytes に入る)
   * - `noop`: ゴミ箱が既に空だった
   */
  readonly method: 'osascript' | 'dry-run' | 'noop' | 'inaccessible';
  readonly freedBytes: number;
  readonly errorMessage?: string;
}

/** ゴミ箱にアクセスできない時にユーザーへ出す案内文。 */
export const TRASH_INACCESSIBLE_GUIDANCE =
  'ゴミ箱にアクセスできず自動で空にできません（macOS の保護）。' +
  '実ディスクを解放するには Finder でゴミ箱を空にする（⌘⇧⌫）か、' +
  'ターミナル/molt に「フルディスクアクセス」または Finder の「オートメーション」許可を与えてください。';

/**
 * `du -sk <TRASH_DIR>` の 1 行目から KB 数を抽出してバイトに変換。
 * 失敗時は 0 を返す（壊れた出力で例外伝播させない）。
 */
export function parseDuKbLine(line: string): number {
  if (!line) return 0;
  const tabIdx = line.indexOf('\t');
  const raw = tabIdx === -1 ? line.trim().split(/\s+/)[0] ?? '' : line.slice(0, tabIdx);
  const kb = Number.parseInt(raw, 10);
  if (Number.isNaN(kb) || kb < 0) return 0;
  return kb * 1024;
}

/**
 * `ls -1A` の出力から実エントリ数をカウント。
 * 空行・空白行は除外。
 */
export function countLsEntries(stdout: string): number {
  if (!stdout) return 0;
  return stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * コマンドの失敗が「権限拒否 (TCC / Full Disk Access 未許可)」由来か判定する pure helper。
 * exit≠0 かつ stderr に権限拒否の典型メッセージが含まれる場合のみ true。
 * 権限以外の一般エラーを inaccessible と誤判定しないため、メッセージで絞る。
 */
export function isAccessDenied(exitCode: number, stderr: string): boolean {
  if (exitCode === 0) return false;
  return /operation not permitted|permission denied|not permitted/i.test(stderr);
}

/**
 * ゴミ箱の現在のサイズと項目数を取得。
 * `~/.Trash` が存在しない場合は空として返す（macOS 新規ユーザー等）。
 * 権限拒否で読めない場合は accessible=false（「空」ではなく「不明」）。
 */
export async function getTrashContents(): Promise<TrashContents> {
  if (!existsSync(TRASH_DIR)) {
    return { path: TRASH_DIR, sizeBytes: 0, itemCount: 0, accessible: true };
  }

  const [size, itemCount] = await Promise.all([
    measureTrashSize(),
    countTrashItems(),
  ]);

  return {
    path: TRASH_DIR,
    sizeBytes: size.sizeBytes,
    itemCount,
    accessible: !size.accessDenied,
  };
}

async function measureTrashSize(): Promise<{ sizeBytes: number; accessDenied: boolean }> {
  const proc = spawn(['du', '-sk', TRASH_DIR], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    return { sizeBytes: 0, accessDenied: isAccessDenied(proc.exitCode ?? 1, stderr) };
  }
  const stdout = await new Response(proc.stdout).text();
  const firstLine = stdout.split('\n')[0] ?? '';
  return { sizeBytes: parseDuKbLine(firstLine), accessDenied: false };
}

async function countTrashItems(): Promise<number> {
  // ls -1A: 1 列出力 + ドットファイル含む (但し . と .. は除外)
  const proc = spawn(['ls', '-1A', TRASH_DIR], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  if (proc.exitCode !== 0) return 0;
  const stdout = await new Response(proc.stdout).text();
  return countLsEntries(stdout);
}

/**
 * ゴミ箱を空にする。
 *
 * 実装: `osascript -e 'tell application "Finder" to empty trash'`
 * - Finder 経由で削除するため、ロックファイル等の macOS 慣習を尊重
 * - 同期実行 (osascript の exit code を await)
 * - dryRun=true なら呼び出さず success=true を返す
 * - caller が既に getTrashContents() を呼んでいる場合は contents で渡すと
 *   二重 du/ls 呼び出しを避けられる (パフォーマンス最適化)
 *
 * 失敗時は明示エラー (rm へのフォールバックは行わない — 直接 rm はメタデータ
 * 整合性を壊す可能性があるため、ユーザーに手動 osascript / Finder GUI を促す)。
 */
export async function emptyTrash(
  options: {
    readonly dryRun?: boolean;
    /** 既知のゴミ箱状態を再利用する場合に渡す (未指定時は内部で取得) */
    readonly contents?: TrashContents;
  } = {},
): Promise<EmptyTrashResult> {
  const before = options.contents ?? await getTrashContents();

  // 権限拒否でゴミ箱を読めない時は「空(noop)」と誤判定せず、案内付きで失敗を返す。
  // (中身が残っているのに「空にした」と偽成功するのを防ぐ)
  if (!before.accessible) {
    return {
      success: false,
      method: 'inaccessible',
      freedBytes: 0,
      errorMessage: TRASH_INACCESSIBLE_GUIDANCE,
    };
  }

  if (before.itemCount === 0) {
    return { success: true, method: 'noop', freedBytes: 0 };
  }

  if (options.dryRun) {
    return {
      success: true,
      method: 'dry-run',
      freedBytes: before.sizeBytes,
    };
  }

  const proc = spawn(
    ['osascript', '-e', 'tell application "Finder" to empty trash'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderrRaw = (await new Response(proc.stderr).text()).trim();
    return {
      success: false,
      method: 'osascript',
      freedBytes: 0,
      errorMessage: sanitizeErrorMessage(stderrRaw) ||
        `osascript exited with code ${proc.exitCode}`,
    };
  }

  // 削除後の状態でどれだけ解放されたか測る
  const after = await getTrashContents();
  return {
    success: true,
    method: 'osascript',
    freedBytes: Math.max(0, before.sizeBytes - after.sizeBytes),
  };
}

/**
 * stderr を表示する前に ANSI エスケープと制御文字を取り除く。
 * ターミナル/ログ汚染防止 (security-reviewer の MED 指摘対応)。
 */
export function sanitizeErrorMessage(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')          // ANSI CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // その他制御文字 (改行・タブは残す)
}
