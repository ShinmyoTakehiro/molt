// 学習データ永続化（decisions.json）。
//
// JSON 採用理由:
//   - Bun / Swift 両方から読みやすい
//   - 標準ライブラリで完結（YAML 依存追加しない）

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_DIR, DECISIONS_FILE } from './config.ts';
import { checkSchemaVersion, withSchema } from './types.ts';
import type { Decision } from './types.ts';

/** decisions.json のパース後形 */
interface DecisionsFile {
  /** 旧フォーマット (version) と新フォーマット (schemaVersion) の両対応 */
  readonly schemaVersion?: number;
  readonly version?: number;
  readonly decisions: ReadonlyArray<Decision>;
}

/**
 * 学習データを読み込む。ファイルがなければ空配列。
 * schemaVersion 不一致は warn のみで読込続行。
 */
export async function loadDecisions(): Promise<Decision[]> {
  if (!existsSync(DECISIONS_FILE)) return [];
  try {
    const content = await Bun.file(DECISIONS_FILE).text();
    const parsed = JSON.parse(content) as DecisionsFile;
    // schemaVersion 優先、なければ legacy version をフォールバック
    if (parsed.schemaVersion !== undefined) {
      checkSchemaVersion(parsed, DECISIONS_FILE);
    } else if (parsed.version !== undefined) {
      console.warn(`⚠️  ${DECISIONS_FILE}: legacy 'version' フィールド検出 (v${parsed.version})。次回保存時に schemaVersion に移行されます`);
    } else {
      console.warn(`⚠️  ${DECISIONS_FILE}: schemaVersion 欠落`);
    }
    return [...parsed.decisions];
  } catch (e) {
    throw new Error(`decisions.json の読み込み失敗: ${(e as Error).message}`);
  }
}

/**
 * 学習データを保存する。ディレクトリは自動作成。
 * 既存ファイルは .bak としてバックアップ。
 */
export async function saveDecisions(decisions: ReadonlyArray<Decision>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });

  // バックアップ
  if (existsSync(DECISIONS_FILE)) {
    const bak = DECISIONS_FILE + '.bak';
    await Bun.write(bak, await Bun.file(DECISIONS_FILE).text());
  }

  const payload = withSchema({ decisions });
  await Bun.write(DECISIONS_FILE, JSON.stringify(payload, null, 2));
}

/**
 * パス1件の判定を追加または更新する。
 */
export async function upsertDecision(decision: Decision): Promise<void> {
  const current = await loadDecisions();
  const filtered = current.filter((d) => d.path !== decision.path);
  await saveDecisions([...filtered, decision]);
}

/**
 * パスの判定を削除する（再評価対象に戻す）。
 */
export async function removeDecision(path: string): Promise<boolean> {
  const current = await loadDecisions();
  const filtered = current.filter((d) => d.path !== path);
  if (filtered.length === current.length) return false;
  await saveDecisions(filtered);
  return true;
}

/**
 * ディレクトリ初期化（権限・存在確認用）。
 */
export async function ensureStorageDirs(): Promise<void> {
  await mkdir(dirname(DECISIONS_FILE), { recursive: true });
}
