// 中央型定義。全モジュールはここから import する。

// ─────────────────────────────────────────
// 永続化スキーマバージョニング (G1)
// ─────────────────────────────────────────

/**
 * 全ての永続化 JSON ファイル (decisions / snapshot / log / meta / index) が
 * 共有する単一バージョン番号。
 *
 * 後方互換性が壊れるスキーマ変更時に上げる。Swift 実装 (Phase 5) は
 * このバージョンを見て安全に読み込めるか判断する。
 */
export const SCHEMA_VERSION = 1;

/** 全永続化ファイルの共通ヘッダ */
export interface PersistedRoot {
  readonly schemaVersion: number;
}

/**
 * オブジェクトに schemaVersion を付与した新オブジェクトを返す (immutable)。
 * シリアライザはこの戻り値を JSON.stringify する。
 */
export function withSchema<T extends object>(data: T): T & PersistedRoot {
  return { schemaVersion: SCHEMA_VERSION, ...data };
}

/**
 * パース済み JSON が想定するバージョンか確認する。
 * 不一致は warn のみ (リーダブロックはせず、ベストエフォートで読む)。
 *
 * @returns 検出した schemaVersion (見つからなければ 0)
 */
export function checkSchemaVersion(parsed: unknown, source: string): number {
  if (!parsed || typeof parsed !== 'object') return 0;
  const v = (parsed as Partial<PersistedRoot>).schemaVersion;
  if (typeof v !== 'number') {
    console.warn(`⚠️  ${source}: schemaVersion フィールド欠落 (v0 として読込)`);
    return 0;
  }
  if (v !== SCHEMA_VERSION) {
    console.warn(`⚠️  ${source}: schemaVersion 不一致 (got ${v}, expected ${SCHEMA_VERSION}). 読込続行`);
  }
  return v;
}

export type Classification = 'SAFE' | 'CAREFUL' | 'DANGER' | 'UNKNOWN';

export type DecidedBy = 'rule' | 'user' | 'ai' | 'default';

/**
 * 再生成コスト (v0.2)。regenerable=true の項目が「消した後どう復元されるか」。
 * interactive review で「失うもの」を提示する根拠に使う。
 *
 * - `auto`       : 次回アクセスで自動再生成（各種 cache 等）
 * - `redownload` : リモートから再ダウンロード（npm/pip/Android system-image 等）
 * - `rebuild`    : ビルドし直すと復元（Xcode DerivedData 等）
 * - `reinstall`  : アプリ/環境を再インストールで復元（iOS Sim Devices, node_modules 等）
 */
export type RegenCost = 'auto' | 'redownload' | 'rebuild' | 'reinstall';

/** スキャンで発見されたパス */
export interface ScannedPath {
  readonly path: string;        // 絶対パス
  readonly sizeBytes: number;
  readonly fileCount?: number;  // 任意（高コストのため scan 時は省略可）
  readonly oldestMtime?: Date;
  readonly newestMtime?: Date;
}

/** 分類結果付きパス */
export interface ClassifiedPath extends ScannedPath {
  readonly classification: Classification;
  readonly reason: string;
  readonly decidedBy: DecidedBy;
  readonly ruleName?: string;
  /**
   * v0.2: 消しても外部から復元できる項目か（3条件: 復元元が外部 / ユニークな
   * ユーザーデータを含まない / 復元方法が既知）。未付与=undefined は false 相当。
   * **DANGER には決して付かない**（不変条件・rules.test で保証）。
   */
  readonly regenerable?: boolean;
  /** v0.2: regenerable=true 時の復元コスト。review の「失うもの」提示に使う。 */
  readonly regenCost?: RegenCost;
}

/** 分類ルール */
export interface Rule {
  readonly name: string;
  readonly reason: string;
  readonly classify: (path: string) => Classification | null;
  /** v0.2: このルールにマッチした項目が再生成可なら true（SAFE/CAREFUL のみ）。 */
  readonly regenerable?: boolean;
  /** v0.2: regenerable=true 時の復元コスト。 */
  readonly regenCost?: RegenCost;
}

/** ユーザー判定の永続化形式 */
export interface Decision {
  readonly path: string;
  readonly classification: Classification;
  readonly decidedAt: string;   // ISO 8601
  readonly decidedBy: DecidedBy;
  readonly source: string;      // 'user' | 'rule:<name>' | 'ai:<model>'
  readonly note?: string;
}

/** スナップショット */
export interface Snapshot {
  readonly timestamp: string;          // ISO 8601
  readonly totalSizeBytes: number;
  readonly freeSizeBytes: number;
  readonly paths: Readonly<Record<string, number>>;  // path -> sizeBytes
}

/** 削除実行ログ */
export interface CleanupLog {
  readonly timestamp: string;
  readonly mode: 'trash' | 'purge';
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly sizeBytes: number;
    readonly result: 'success' | 'skipped' | 'error';
    readonly errorMessage?: string;
  }>;
  readonly totalFreedBytes: number;
}

/**
 * スキャン対象 root の指定方法。
 *
 * - `string`: パスのみ。depth は {@link ScanOptions.depth} or {@link DEFAULTS.scanDepth} を使う。
 * - `ScanRoot`: path + 個別 depth。重い root は深く・軽い root は浅く動的調整できる。
 *
 * 後方互換のため、両方を許容する union 型。
 */
export type ScanRootSpec = string | ScanRoot;

/** root ごとの個別スキャン設定 */
export interface ScanRoot {
  readonly path: string;
  /** この root だけに適用する深度。未指定なら fallback depth を使う */
  readonly depth?: number;
}

/** スキャンオプション */
export interface ScanOptions {
  readonly roots?: ReadonlyArray<ScanRootSpec>;
  /** 個別指定なし root の fallback depth */
  readonly depth?: number;
  readonly minSizeBytes?: number;
  readonly excludePaths?: ReadonlyArray<string>;
}

/** 削除オプション */
export interface CleanOptions {
  readonly dryRun?: boolean;
  readonly purge?: boolean;          // true: 完全削除 / false: ゴミ箱
  readonly classifications?: ReadonlyArray<Classification>;  // 対象（既定: SAFE のみ）
  readonly ageThresholdDays?: number;  // この日数以内変更の項目はスキップ
}
