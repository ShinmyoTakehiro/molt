// 内蔵分類ルール
//
// 各ルールは path → Classification or null を返す。
// 上から順に評価し、最初にマッチしたルールが採用される。

import type { Rule } from './types.ts';

// ─────────────────────────────────────────
// Chromium 系アプリの共通正規表現プレフィックス
// ─────────────────────────────────────────
//
// `Application Support/<segments>/<DataDir>` パターンの共通部分。
// 12 個の electron-* ルールで再利用するため定数化。
//
// セグメント数 `{1,3}` の根拠:
//   1: Notion, Discord, Cursor, WhatsApp 等の単一名 Electron アプリ
//   2: Microsoft Edge/Default
//   3: Google/Chrome/Default, BraveSoftware/Brave-Browser/Default, Slack/Partitions/<id>
//
// なぜ {1,4} に拡張しないか:
//   4+ セグメントの未知アプリは `application-support` ルール (CAREFUL) に
//   フォールスルーされる。これは「未知 → ユーザー確認必須」という保守的な
//   挙動であり、サイレント機能不全ではなくフェイルセーフ設計。
//   拡張すると逆に SAFE 判定の over-match リスクが増える。
const CHROMIUM_PREFIX = String.raw`\/Application Support\/(?:[^/]+\/){1,3}`;

// 事前コンパイル済み正規表現 (ホットパスで new RegExp を避ける)
const CHROMIUM_RE = {
  cookies: new RegExp(`${CHROMIUM_PREFIX}Cookies(-journal)?$`),
  localStorage: new RegExp(`${CHROMIUM_PREFIX}Local Storage(\\/|$)`),
  indexedDb: new RegExp(`${CHROMIUM_PREFIX}IndexedDB(\\/|$)`),
  sessionStorage: new RegExp(`${CHROMIUM_PREFIX}Session Storage(\\/|$)`),
  blobStorage: new RegExp(`${CHROMIUM_PREFIX}blob_storage(\\/|$)`),
  webStorage: new RegExp(`${CHROMIUM_PREFIX}WebStorage(\\/|$)`),
  serviceWorker: new RegExp(`${CHROMIUM_PREFIX}Service Worker(\\/|$)`),
  httpCache: new RegExp(`${CHROMIUM_PREFIX}Cache(\\/|$)`),
  codeCache: new RegExp(`${CHROMIUM_PREFIX}Code Cache(\\/|$)`),
  gpuCache: new RegExp(`${CHROMIUM_PREFIX}(GPUCache|DawnWebGPUCache|DawnGraphiteCache|ShaderCache)(\\/|$)`),
  crashReports: new RegExp(`${CHROMIUM_PREFIX}(Crash Reports|Crashpad)(\\/|$)`),
  sharedDictionary: new RegExp(`${CHROMIUM_PREFIX}Shared Dictionary(\\/|$)`),
};

export const BUILTIN_RULES: ReadonlyArray<Rule> = [
  // ─────────────────────────────────────────
  // DANGER: 絶対に消さない（多層防御）
  // ─────────────────────────────────────────
  {
    name: 'ssh-keys',
    reason: 'SSH 鍵、絶対に消さない',
    classify: (p) => /\/\.ssh(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'gpg-keys',
    reason: 'GPG 鍵、絶対に消さない',
    classify: (p) => /\/\.gnupg(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'aws-creds',
    reason: 'AWS 認証情報',
    classify: (p) => /\/\.aws(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'kubernetes-config',
    reason: 'Kubernetes 設定・認証情報',
    classify: (p) => /\/\.kube(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'gh-config',
    reason: 'GitHub CLI 認証',
    classify: (p) => /\/\.config\/gh(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'mail-data',
    reason: 'メールデータ',
    classify: (p) => /\/Library\/Mail(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'messages-data',
    reason: 'メッセージ履歴',
    classify: (p) => /\/Library\/Messages(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'icloud-data',
    reason: 'iCloud Drive 同期データ',
    classify: (p) => /\/Library\/Mobile Documents(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'keychain',
    reason: 'Keychain（パスワード等）',
    classify: (p) => /\/Library\/Keychains(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'safari-data',
    reason: 'Safari 設定・履歴',
    classify: (p) => /\/Library\/Safari(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'documents',
    reason: 'ユーザードキュメント',
    classify: (p) => /\/Documents(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'desktop',
    reason: 'デスクトップ（作業中ファイルの可能性）',
    classify: (p) => /\/Desktop(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'pictures',
    reason: '写真',
    classify: (p) => /\/Pictures(\/|$)/.test(p) ? 'DANGER' : null,
  },
  {
    name: 'downloads',
    reason: 'ダウンロード（未保存ファイルの可能性）',
    classify: (p) => /\/Downloads(\/|$)/.test(p) ? 'DANGER' : null,
  },
  // C2: ユーザー追加フォント。削除するとドキュメント表示・印刷が崩れる
  {
    name: 'user-fonts',
    reason: 'ユーザー追加フォント（削除でドキュメント表示崩壊）',
    classify: (p) => /\/Library\/Fonts(\/|$)/.test(p) ? 'DANGER' : null,
  },

  // ─────────────────────────────────────────
  // SAFE: 自動再生成・削除して問題なし
  // ─────────────────────────────────────────
  {
    name: 'xcode-derived-data',
    reason: 'Xcode が自動再生成する build キャッシュ',
    classify: (p) => /\/Library\/Developer\/Xcode\/DerivedData(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'rebuild',
  },
  {
    name: 'core-simulator-caches',
    reason: 'iOS シミュレータの一時キャッシュ',
    classify: (p) => /\/Library\/Developer\/CoreSimulator\/Caches(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'caches-dir',
    reason: 'macOS 標準キャッシュ領域、自動再生成',
    classify: (p) => /\/Library\/Caches(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'logs-dir',
    reason: 'ログファイル',
    classify: (p) => /\/Library\/Logs(\/|$)/.test(p) ? 'SAFE' : null,
  },
  {
    name: 'trash',
    reason: 'ゴミ箱',
    classify: (p) => /\/\.Trash(\/|$)/.test(p) ? 'SAFE' : null,
  },
  {
    name: 'npm-cache',
    reason: 'npm キャッシュ',
    classify: (p) => /\/\.npm(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'yarn-cache',
    reason: 'Yarn キャッシュ',
    classify: (p) => /\/Library\/Caches\/Yarn(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'pnpm-store',
    reason: 'pnpm ストア（再 install 可）',
    classify: (p) => /\/Library\/pnpm(\/|$)|\/\.pnpm-store(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'bun-cache',
    reason: 'Bun キャッシュ',
    classify: (p) => /\/\.bun\/install\/cache(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  // C3: Python パッケージマネージャのキャッシュ（再 install 可）
  {
    name: 'uv-cache',
    reason: 'uv (Python パッケージマネージャ) キャッシュ',
    classify: (p) => /\/\.cache\/uv(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'pip-cache',
    reason: 'pip キャッシュ（wheels 等は再ダウンロード可）',
    classify: (p) => /\/\.cache\/pip(\/|$)/.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'docker-desktop-cache',
    reason: 'Docker Desktop キャッシュ',
    classify: (p) => /\/Library\/Containers\/com\.docker\.docker\/Data\/cache(\/|$)/.test(p) ? 'SAFE' : null,
  },

  // ─────────────────────────────────────────
  // Chromium 系アプリ汎用ルール (Electron + ブラウザ)
  //
  // 共通パス構造:
  //   Application Support/<segments>/<DataDir>
  //
  // 対応パターン (1-3 セグメント):
  //   1セグメント: Notion / Cursor / Discord / WhatsApp / Teams 等の Electron
  //   2セグメント: Microsoft Edge/Default
  //   3セグメント: Slack/Partitions/<id>, Google/Chrome/Default, BraveSoftware/Brave-Browser/Default
  //
  // 注意: DANGER（Cookies / Local Storage / IndexedDB / Session Storage）を
  // 必ず先に評価。SAFE（Service Worker / Cache 系）を後に。
  // generic `application-support` CAREFUL より先に評価される必要あり。
  //
  // B-1 (2026-05-21): `[^/]+(\/Partitions\/[^/]+)?` を `(?:[^/]+\/){1,3}` に
  // 一般化し、Chrome/Brave/Edge も同じルールでカバー。
  // ─────────────────────────────────────────

  // 🔴 Chromium DANGER: ログイン・設定・ユーザーデータ
  {
    name: 'electron-cookies',
    reason: 'ログインクッキー、消すとサインアウト',
    classify: (p) => CHROMIUM_RE.cookies.test(p) ? 'DANGER' : null,
  },
  {
    name: 'electron-local-storage',
    reason: 'アプリ設定・状態（消すとリセット）',
    classify: (p) => CHROMIUM_RE.localStorage.test(p) ? 'DANGER' : null,
  },
  {
    name: 'electron-indexed-db',
    reason: 'アプリのオフラインデータ（チャット履歴等）',
    classify: (p) => CHROMIUM_RE.indexedDb.test(p) ? 'DANGER' : null,
  },
  {
    name: 'electron-session-storage',
    reason: 'セッション状態',
    classify: (p) => CHROMIUM_RE.sessionStorage.test(p) ? 'DANGER' : null,
  },
  {
    name: 'electron-blob-storage',
    reason: 'バイナリストレージ（添付ファイル等）',
    classify: (p) => CHROMIUM_RE.blobStorage.test(p) ? 'DANGER' : null,
  },
  // 注意: WebStorage ディレクトリは命名が紛らわしいが Service Worker の
  // CacheStorage の親であり、再生成可能なキャッシュ。Chromium の Web Storage API
  // (localStorage / sessionStorage) は別ディレクトリ (`Local Storage`/`Session Storage`)
  // に保存され、それぞれ electron-local-storage / electron-session-storage で
  // DANGER として守られている。WebStorage 自体は SAFE で問題なし。
  //
  // 注: 本ルールは元々 DANGER として誤って WebStorage を保護していたが、
  // Cursor の WebStorage 配下を実調査して CacheStorage 系のみと確認し
  // 2026-05-21 に SAFE 化。影響範囲は調査時点で Cursor のみ。

  // 🟢 Chromium SAFE: キャッシュ系（再ログイン不要、再生成される）
  {
    name: 'electron-web-storage',
    reason: 'WebStorage 下の CacheStorage、再生成可',
    classify: (p) => CHROMIUM_RE.webStorage.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-service-worker',
    reason: 'Chromium アプリのオフラインキャッシュ、再ログイン不要',
    classify: (p) => CHROMIUM_RE.serviceWorker.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-http-cache',
    reason: 'Chromium HTTP キャッシュ',
    classify: (p) => CHROMIUM_RE.httpCache.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-code-cache',
    reason: 'V8 コードキャッシュ（再コンパイルされる）',
    classify: (p) => CHROMIUM_RE.codeCache.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-gpu-cache',
    reason: 'GPU シェーダキャッシュ',
    classify: (p) => CHROMIUM_RE.gpuCache.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-crash-reports',
    reason: 'クラッシュレポート、開発者デバッグ済みなら不要',
    classify: (p) => CHROMIUM_RE.crashReports.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'electron-shared-dictionary',
    reason: '共有辞書キャッシュ',
    classify: (p) => CHROMIUM_RE.sharedDictionary.test(p) ? 'SAFE' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'app-shipit-update',
    reason: '適用済みアプリ更新インストーラ（ShipIt）',
    classify: (p) =>
      /\/Library\/Caches\/[^/]+\.ShipIt(\/|$)/.test(p)
        ? 'SAFE' : null,
  },

  // ─────────────────────────────────────────
  // CAREFUL: ケースバイケース、要確認
  // ─────────────────────────────────────────
  {
    name: 'xcode-archives',
    reason: 'Xcode アーカイブ（配布履歴）',
    classify: (p) => /\/Library\/Developer\/Xcode\/Archives(\/|$)/.test(p) ? 'CAREFUL' : null,
  },
  {
    name: 'xcode-ios-device-support',
    reason: 'iOS DeviceSupport（古い iOS 版は削除可）',
    classify: (p) => /\/Library\/Developer\/Xcode\/iOS DeviceSupport(\/|$)/.test(p) ? 'CAREFUL' : null,
    regenerable: true,
    regenCost: 'auto',
  },
  {
    name: 'core-simulator-devices',
    reason: 'iOS シミュレータデータ（アプリ設定含む）',
    classify: (p) => /\/Library\/Developer\/CoreSimulator\/Devices(\/|$)/.test(p) ? 'CAREFUL' : null,
    regenerable: true,
    regenCost: 'reinstall',
  },
  {
    name: 'node-modules',
    reason: 'プロジェクト依存（再 install 可、時間かかる）',
    classify: (p) => /\/node_modules(\/|$)/.test(p) ? 'CAREFUL' : null,
    regenerable: true,
    regenCost: 'reinstall',
  },
  {
    // v0.2: Android SDK の system-image (エミュレータイメージ)。SDK Manager で再DL可。
    // 注意: ~/.android/avd (ユーザー作成 AVD・ユニーク設定含む) は対象外。
    // system-images のみを redownload 扱いとし、avd には決してマッチさせない。
    name: 'android-system-image',
    reason: 'Android エミュレータの system-image（SDK Manager で再DL可）',
    classify: (p) => /\/Library\/Android\/sdk\/system-images(\/|$)/.test(p) ? 'CAREFUL' : null,
    regenerable: true,
    regenCost: 'redownload',
  },
  {
    name: 'application-support',
    reason: 'アプリ別データ。設定・ログ・キャッシュ混在',
    classify: (p) => /\/Library\/Application Support(\/|$)/.test(p) ? 'CAREFUL' : null,
  },
  {
    name: 'group-containers',
    reason: 'アプリグループ共有データ',
    classify: (p) => /\/Library\/Group Containers(\/|$)/.test(p) ? 'CAREFUL' : null,
  },
  {
    name: 'containers',
    reason: 'サンドボックスアプリのデータ',
    classify: (p) => /\/Library\/Containers(\/|$)/.test(p) ? 'CAREFUL' : null,
  },
];

/**
 * パスを内蔵ルールで分類。マッチしなければ null。
 * 内蔵ルールは UNKNOWN を返さない（その場合は null）ため、
 * 戻り値の classification は SAFE / CAREFUL / DANGER のいずれか。
 */
export function applyBuiltinRules(
  path: string,
): { classification: 'SAFE' | 'CAREFUL' | 'DANGER'; rule: Rule } | null {
  for (const rule of BUILTIN_RULES) {
    const result = rule.classify(path);
    if (result !== null && result !== 'UNKNOWN') {
      return { classification: result, rule };
    }
  }
  return null;
}
