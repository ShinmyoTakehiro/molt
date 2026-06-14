// パス階層に関する pure ユーティリティ。
// cleaner（削除対象の重複排除）と reporter（summary 集計の重複排除）で共有する。

/**
 * 親パスが既にリストにあれば子パスを除外する（祖先優先）。
 *
 * ネストしたディレクトリのサイズは親に内包されるため、合計すると二重計上になる。
 * このヘルパーで「祖先を持たないルートのみ」に畳むことで実サイズに近づける。
 *
 * 例: ['/Library/pnpm', '/Library/pnpm/store'] → ['/Library/pnpm']
 *
 * @param items path を持つ任意のオブジェクト配列（immutable に扱う）
 * @returns 祖先を持たない要素のみの新しい配列
 */
export function deduplicateByAncestry<T extends { path: string }>(
  items: ReadonlyArray<T>,
): T[] {
  // 短いパス（=より浅い祖先）を先頭に
  const sorted = [...items].sort((a, b) => a.path.length - b.path.length);
  const accepted: T[] = [];
  for (const item of sorted) {
    const hasAncestor = accepted.some(
      (a) => item.path !== a.path && item.path.startsWith(a.path + '/'),
    );
    if (!hasAncestor) {
      accepted.push(item);
    }
  }
  return accepted;
}
