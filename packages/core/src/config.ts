// パス・定数・除外リスト

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';

export const HOME = homedir();

// XDG Base Directory に準拠
export const CONFIG_DIR = process.env['XDG_CONFIG_HOME']
  ? join(process.env['XDG_CONFIG_HOME'], 'moltmac')
  : join(HOME, '.config', 'moltmac');

export const DATA_DIR = process.env['XDG_DATA_HOME']
  ? join(process.env['XDG_DATA_HOME'], 'moltmac')
  : join(HOME, '.local', 'share', 'moltmac');

export const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const REPORT_DIR = join(DATA_DIR, 'reports');
export const DECISIONS_FILE = join(CONFIG_DIR, 'decisions.json');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const LOCK_FILE = join(DATA_DIR, '.lock');
export const TRASH_DIR = join(HOME, '.Trash');

/**
 * 旧名 (cleanup-mac) の設定/データディレクトリを新名 (moltmac) へ 1 回だけ移行する。
 *
 * v0.1.0 リネーム (cleanup-mac → moltmac) で XDG パスが変わったため、
 * 既存ユーザーの学習データ (decisions.json 等) を引き継ぐ。
 *
 * 安全設計:
 * - **新側が既に存在する場合は何もしない**（上書き/マージ事故を防ぐ）
 * - 旧側が無ければ no-op（新規ユーザー）
 * - 移行失敗は致命にしない（新パスで通常続行）。クリーンアップ本体を止めない
 * - rename のみ（同一ボリューム内）。ファイル内容は読まない
 *
 * @returns 実際に移行したペアのリスト（ログ用）。副作用はファイルシステム rename。
 */
export function migrateLegacyDirs(): ReadonlyArray<{ from: string; to: string }> {
  const legacyConfig = process.env['XDG_CONFIG_HOME']
    ? join(process.env['XDG_CONFIG_HOME'], 'cleanup-mac')
    : join(HOME, '.config', 'cleanup-mac');
  const legacyData = process.env['XDG_DATA_HOME']
    ? join(process.env['XDG_DATA_HOME'], 'cleanup-mac')
    : join(HOME, '.local', 'share', 'cleanup-mac');

  const pairs = [
    { from: legacyConfig, to: CONFIG_DIR },
    { from: legacyData, to: DATA_DIR },
  ];

  const migrated: Array<{ from: string; to: string }> = [];
  for (const pair of pairs) {
    // 旧があり かつ 新が未作成のときのみ移行（冪等・非破壊）
    if (existsSync(pair.from) && !existsSync(pair.to)) {
      try {
        renameSync(pair.from, pair.to);
        migrated.push(pair);
      } catch {
        // 移行失敗（別ボリューム/権限等）は無視して新パスで続行
      }
    }
  }
  return migrated;
}

// スキャン既定値
export const DEFAULTS = {
  /**
   * スキャン対象ルート（クリーンアップ可能性のある場所のみ）。
   *
   * 各 root に個別の depth を指定し、重い場所は深く・軽い場所は浅くスキャンする（A1 動的調整）。
   * - Library: 6 — Application Support/<app>/Cache/Service Worker など深い場所まで拾う必要あり
   * - .Trash: 2 — 直下 + アプリ別フォルダ程度で十分
   * - .cache: 4 — npm/pip/uv 等のキャッシュは中程度の深さ
   */
  scanRoots: [
    { path: join(HOME, 'Library'), depth: 6 },
    { path: join(HOME, '.Trash'), depth: 2 },
    { path: join(HOME, '.cache'), depth: 4 },
    // C1: dev ビルドツールの再DL可キャッシュ（システムデータの肥大要因）。
    // 親 (~/.gradle 等) ではなく cache サブディレクトリを直接 root にすることで、
    // 兄弟の実体 (jdks / settings.xml / cargo bin) を走査面から外す。
    { path: join(HOME, '.gradle', 'caches'), depth: 4 },     // 依存 jar / ビルド中間物
    { path: join(HOME, '.m2', 'repository'), depth: 5 },     // Maven 依存（group/artifact/version で深い）
    { path: join(HOME, '.cargo', 'registry'), depth: 3 },    // crate ソース・index
    { path: join(HOME, '.cargo', 'git'), depth: 3 },         // git 依存（存在しなければ scanner が skip）
  ],
  /** 個別指定がない root に適用する fallback depth */
  scanDepth: 6,
  /** これ未満は無視（バイト） */
  minSizeBytes: 100 * 1024 * 1024,  // 100MB
  /** 何日以内に変更されたファイルは触らない */
  ageThresholdDays: 7,
  /** スナップショット保持件数 */
  snapshotRetention: 12,
} as const;

/**
 * 絶対に削除しない領域のリストを構築する pure 関数。
 *
 * モジュール定数 (HOME 等) に依存せず引数で受けることで、配布バイナリでも
 * 実行環境の実 HOME を使い、**開発者固有パスを焼き込まない**（配布安全性）。
 *
 * @param home        ユーザーの HOME
 * @param configDir   moltmac の設定ディレクトリ
 * @param dataDir     moltmac のデータディレクトリ
 * @param selfHome    moltmac 自身の配置（自己参照防止）。**明示時のみ**追加。
 *                    未指定なら自己参照除外は入れない（dev パスを焼き込まない）。
 */
export function buildHardcodedExcludes(
  home: string,
  configDir: string,
  dataDir: string,
  selfHome?: string,
): ReadonlyArray<string> {
  const base = [
    // ユーザーデータ
    join(home, 'Documents'),
    join(home, 'Desktop'),
    join(home, 'Pictures'),
    join(home, 'Downloads'),
    join(home, 'Movies'),
    join(home, 'Music'),
    join(home, 'Public'),
    // 認証・鍵
    join(home, '.ssh'),
    join(home, '.gnupg'),
    join(home, '.aws'),
    join(home, '.config', 'gh'),
    join(home, '.kube'),
    // C1: cargo install したバイナリ本体（キャッシュではなくインストール済プログラム）。
    // scan 対象は ~/.cargo/registry,git のみだが、手動 --paths 誤指定も多層防御で拒否する。
    join(home, '.cargo', 'bin'),
    // 監査 LOW-1: Maven の認証情報（サーバーパスワード/トークンとそのマスターパスワード）。
    // scan 対象は ~/.m2/repository のみで走査面外だが、手動 --paths 誤指定をフェールセーフで拒否。
    join(home, '.m2', 'settings.xml'),
    join(home, '.m2', 'settings-security.xml'),
    // システム / Library — depth 6 で到達可能になった重要データを多層保護
    join(home, 'Library', 'Mail'),
    join(home, 'Library', 'Messages'),
    join(home, 'Library', 'Mobile Documents'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'Safari'),
    join(home, 'Library', 'Application Support', 'AddressBook'),
    // A1 追加 (depth 6 化で到達可能になった重要データ)
    join(home, 'Library', 'Preferences'),    // アプリ plist — 削除でアプリ破損
    join(home, 'Library', 'Cookies'),        // 全ブラウザのセッションクッキー
    join(home, 'Library', 'Calendars'),      // カレンダーデータ
    join(home, 'Library', 'Contacts'),       // 連絡先データ
    join(home, 'Library', 'HomeKit'),        // スマートホーム設定
    join(home, 'Library', 'Health'),         // ヘルスデータ
    // moltmac 自身のデータ
    configDir,
    dataDir,
  ];
  // 自己参照除外は実体のある絶対パス指定時のみ追加（dev パスを焼き込まない /
  // 空白のみ等の無効値を混入させない）。push による mutation を避け spread で新規生成。
  return selfHome && selfHome.trim().length > 0 ? [...base, selfHome] : base;
}

/**
 * 絶対に削除しない領域。スキャン対象から外し、
 * かつ手動指定でも削除を拒否する多層防御。
 * 自己参照除外は環境変数 MOLTMAC_HOME 指定時のみ。
 */
export const HARDCODED_EXCLUDES: ReadonlyArray<string> = buildHardcodedExcludes(
  HOME,
  CONFIG_DIR,
  DATA_DIR,
  process.env['MOLTMAC_HOME'],
);

/**
 * 指定パスが除外対象か判定。
 *
 * 入力を `resolve()` で正規化してから比較する（多層防御の最終ゲート）。
 * `..` トラバーサル（例: `~/Library/Caches/../../Documents/secret`）で
 * 保護領域に入るパスを startsWith 比較がすり抜けるのを防ぐ。
 * HARDCODED_EXCLUDES 側は join で正規化済みなので、入力側も正規化して揃える。
 */
export function isExcluded(path: string): boolean {
  const normalized = resolve(path);
  return HARDCODED_EXCLUDES.some(
    (excl) => normalized === excl || normalized.startsWith(excl + '/'),
  );
}

/**
 * バイト数を人間可読形式に (decimal SI 単位: 1 GB = 1000^3 bytes)。
 *
 * macOS の Finder / About This Mac / diskutil 等の UI と一致させるため
 * binary (1024^3 = GiB) ではなく decimal (1000^3 = GB) を採用。
 * これにより `Used + Free ≒ Total` の足し算が目視で合うようになる。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1000 ** 2) return `${(bytes / 1000).toFixed(1)}KB`;
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1000 ** 3).toFixed(2)}GB`;
}
