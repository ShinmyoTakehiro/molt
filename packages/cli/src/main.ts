#!/usr/bin/env bun
// molt CLI エントリポイント。

import {
  SCHEMA_VERSION,
  HOME,
  buildSnapshot,
  classifyAll,
  diffSnapshots,
  emptyTrash,
  DEFAULTS,
  ensureStorageDirs,
  execute,
  expandWithDecisions,
  formatBytes,
  getDiskInfo,
  getTrashContents,
  loadDecisions,
  loadIndex,
  loadLatestSnapshot,
  removeDecision,
  renderJson,
  renderMarkdown,
  renderRecoveryProjection,
  renderText,
  projectedFreeBytes,
  scan,
  selectTargets,
  selectTargetsByPaths,
  selectReviewCandidates,
  isActive,
  interpretReviewAnswer,
  deduplicateByAncestry,
  serializeLog,
  serializeSnapshot,
  startRun,
  TRASH_INACCESSIBLE_GUIDANCE,
  upsertDecision,
  migrateLegacyDirs,
} from '@moltmac/core';
import type { ClassifiedPath, ReviewAnswer } from '@moltmac/core';

// ─────────────────────────────────────────
// JSON 出力ヘルパー (G3 --json フラグ)
// ─────────────────────────────────────────

/**
 * --json モード時の出力。type タグ + schemaVersion 付き envelope で stdout 出力。
 * narrative メッセージは出さない (機械パース可能性を保証)。
 */
function emitJson(type: string, data: object): void {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, type, ...data }, null, 2));
}

// ─────────────────────────────────────────
// 引数パース（極小ヘルパー、外部依存ゼロ）
// ─────────────────────────────────────────
function parseFlags(argv: ReadonlyArray<string>): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const [, , command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

// ─────────────────────────────────────────
// コマンド定義
// ─────────────────────────────────────────

async function cmdHelp(): Promise<void> {
  console.log(`
molt - Mac のシステムデータを、学習しながら安全に減らす（moltmac）

USAGE
  molt <command> [options]

COMMANDS
  scan              ディスクをスキャンして分類レポートを表示
  clean             SAFE 判定パスをゴミ箱へ移動（要確認）
  empty-trash       ゴミ箱を空にして実ディスクを解放（要確認）
  diff              前回スナップショットとの差分を表示
  history           過去の実行履歴を表示
  forget <path>     学習データから指定パスの判定を削除
  decide <path> <classification>
                    特定パスを SAFE/CAREFUL/DANGER に手動分類
  help              このヘルプ

OPTIONS (clean / empty-trash)
  --dry-run         実際には削除せず、対象を表示するのみ
  --yes             確認プロンプトをスキップ
  --purge           ゴミ箱経由せず完全削除（dangerous, clean のみ）
  --include-careful CAREFUL も削除対象に含める（clean のみ・一括）
  --interactive     再生成可な CAREFUL を1件ずつ確認して追加（clean のみ・対話）
  --paths a,b,c     指定パスのみ削除（DANGER/除外/未スキャンは自動で弾く・skill 用）

OPTIONS (any command — GUI / 機械処理向け)
  --json            narrative 出力を抑制し、構造化 JSON を stdout に出力
                    (schemaVersion 付き envelope, GUI/Swift 連携用)
                    ⚠️  clean / empty-trash では暗黙の --yes として動作
                        (確認プロンプトをスキップ)

EXAMPLES
  molt scan
  molt clean --dry-run
  molt clean --interactive
  molt clean --yes
  molt empty-trash --dry-run
  molt empty-trash --yes
  molt decide ~/Library/Caches/foo SAFE
  molt forget ~/Library/Caches/foo
`);
}

async function cmdScan(flags: Record<string, string | boolean>): Promise<void> {
  const jsonOutput = !!flags['json'];
  if (!jsonOutput) console.log('🔍 スキャン中…');
  const startedAt = Date.now();
  const run = await startRun('scan', process.argv);

  const [rawScanned, diskInfo, decisions, prevSnapshot] = await Promise.all([
    scan(),
    getDiskInfo(),
    loadDecisions(),
    loadLatestSnapshot(),
  ]);
  const scanned = await expandWithDecisions(
    rawScanned,
    decisions.map((d) => d.path),
  );
  const classified = classifyAll(scanned, decisions);
  const snapshot = buildSnapshot(scanned, diskInfo);
  const diff = prevSnapshot ? diffSnapshots(prevSnapshot, snapshot) : null;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // run ディレクトリに保存 (--json 時もファイル保存は行う)
  const snapshotPath = await run.writeFile('snapshot.json', serializeSnapshot(snapshot));
  const reportPath = await run.writeFile('report.md', renderMarkdown({ classified, diskInfo, diff }));
  await run.finish({
    freeBytesBefore: diskInfo.freeBytes,
    freeBytesAfter: diskInfo.freeBytes,
  });

  const scanRoots = DEFAULTS.scanRoots.map((r) => r.path);
  if (jsonOutput) {
    // renderJson に extraFields を渡して二度手間 (parse → re-spread) を回避
    console.log(renderJson(
      { classified, diskInfo, diff, scanRoots },
      {
        runId: run.id,
        elapsedSeconds: Number(elapsed),
        snapshotPath,
        reportPath,
      },
    ));
    return;
  }

  console.log(renderText({ classified, diskInfo, diff, scanRoots }));
  console.log(`\n⏱  スキャン時間: ${elapsed}s`);
  console.log(`📁 Run: ${run.id}`);
  console.log(`📄 レポート: ${reportPath}`);
  console.log(`📸 スナップショット: ${snapshotPath}`);
}

async function cmdClean(flags: Record<string, string | boolean>): Promise<void> {
  const dryRun = !!flags['dry-run'];
  const skipConfirm = !!flags['yes'];
  const purge = !!flags['purge'];
  const includeCareful = !!flags['include-careful'];
  const interactive = !!flags['interactive'];
  const jsonOutput = !!flags['json'];

  // 安全ガード: --purge は復元不可（rm -rf）。--json は確認プロンプトを抑制するため、
  // `clean --purge --json` は無確認の永久削除になってしまう。明示的な --yes を必須とし、
  // 意図しない自動化/GUI 経由の永久削除を防ぐ。
  if (purge && jsonOutput && !skipConfirm) {
    emitJson('error', {
      error:
        '--purge --json は無確認の永久削除になるため拒否しました。意図的に実行する場合は --yes を明示してください。',
    });
    process.exitCode = 1;
    return;
  }

  // --interactive は人間の対話用。機械処理(--json)・非TTY(CI/パイプ)では成立しないため拒否。
  if (interactive && jsonOutput) {
    emitJson('error', { error: '--interactive と --json は併用できません（対話は機械処理と両立しない）。' });
    process.exitCode = 1;
    return;
  }
  // --paths（明示パス指定）と --interactive（対話）は入力モードが別。併用は曖昧なので拒否。
  if (interactive && typeof flags['paths'] === 'string') {
    const msg = '--paths と --interactive は併用できません（どちらか一方の入力モード）。';
    if (jsonOutput) emitJson('error', { error: msg });
    else console.error(`❌ ${msg}`);
    process.exitCode = 1;
    return;
  }

  // 対話プロンプトは stdin から読むので、判定は stdin の TTY。
  // (stdout はパイプ/リダイレクトされても対話は成立しうる)
  if (interactive && !process.stdin.isTTY) {
    console.error('❌ --interactive は対話端末(TTY)が必要です。非対話なら --include-careful --yes を使ってください。');
    process.exitCode = 1;
    return;
  }

  if (!jsonOutput) console.log('🔍 スキャン中…');
  const run = await startRun('clean', process.argv);

  const [rawScanned, decisions, diskInfoBefore] = await Promise.all([
    scan(),
    loadDecisions(),
    getDiskInfo(),
  ]);
  const scanned = await expandWithDecisions(
    rawScanned,
    decisions.map((d) => d.path),
  );
  const classified = classifyAll(scanned, decisions);

  // 削除対象の決定。
  // - --paths: skill の会話レビューで承認した特定パスだけを安全に削除（core で多層検証）
  // - --interactive: SAFE 自動 + regenerable な CAREFUL を1件ずつ承認（承認分は年齢免除）
  // - 通常: SAFE（+ --include-careful なら CAREFUL 一括）を年齢フィルタ込みで抽出
  const pathsArg = typeof flags['paths'] === 'string' ? (flags['paths'] as string) : undefined;
  let targets: ClassifiedPath[];
  let promotions: string[] = [];
  let rejectedPaths: ReadonlyArray<{ path: string; reason: string }> = [];
  if (pathsArg) {
    const requested = pathsArg.split(',').map((s) => s.trim()).filter(Boolean);
    const sel = selectTargetsByPaths(classified, requested);
    targets = sel.accepted;
    rejectedPaths = sel.rejected;
    if (!jsonOutput && rejectedPaths.length > 0) {
      console.log(`\n⚠️  削除対象から除外 (${rejectedPaths.length} 件):`);
      for (const r of rejectedPaths) console.log(`   - ${r.path}: ${r.reason}`);
    }
  } else if (interactive) {
    const safeTargets = selectTargets(classified, { classifications: ['SAFE'] });
    const review = await runInteractiveReview(classified);
    promotions = review.promotions;
    // SAFE(年齢フィルタ済) + 承認済 CAREFUL(年齢免除) を結合し祖先のみへ畳む
    targets = deduplicateByAncestry([...safeTargets, ...review.approved]);
  } else {
    const targetClasses: Array<'SAFE' | 'CAREFUL'> = ['SAFE'];
    if (includeCareful) targetClasses.push('CAREFUL');
    targets = selectTargets(classified, { classifications: targetClasses });
  }
  const totalBytes = targets.reduce((s, t) => s + t.sizeBytes, 0);

  if (targets.length === 0) {
    if (jsonOutput) {
      emitJson('clean-report', {
        runId: run.id,
        mode: purge ? 'purge' : 'trash',
        dryRun,
        targets: [],
        totalCandidateBytes: 0,
        result: { successCount: 0, errorCount: 0, totalFreedBytes: 0, entries: [] },
      });
    } else {
      console.log('✨ 削除対象なし。');
    }
    await run.finish({ freedBytes: 0, successCount: 0, errorCount: 0 });
    return;
  }

  // narrative プレビュー (JSON モードでは抑制)
  if (!jsonOutput) {
    console.log(`\n🗑  削除候補: ${targets.length} 件 / ${formatBytes(totalBytes)}\n`);
    for (const t of targets.slice(0, 30)) {
      console.log(`  ${formatBytes(t.sizeBytes).padStart(10)}  [${t.classification}]  ${t.path}`);
    }
    if (targets.length > 30) {
      console.log(`  ... 他 ${targets.length - 30} 件`);
    }
    console.log('');
    console.log(`モード: ${purge ? '⚠️  完全削除 (--purge)' : '🗑 ゴミ箱へ移動'}`);
    console.log(`年齢フィルタ: 7 日以内に変更されたファイルはスキップ`);
    // ④ 回収後の空き見込み（ユーザー要望）。trash は empty-trash で確定する旨を注記
    console.log(renderRecoveryProjection({
      currentFreeBytes: diskInfoBefore.freeBytes,
      recoverableBytes: totalBytes,
      mode: purge ? 'purge' : 'trash',
    }));
    console.log('');
  }

  // 確認プロンプト (JSON モード or --yes でスキップ、dry-run でもスキップ)
  if (!jsonOutput && !dryRun && !skipConfirm) {
    const ok = await confirm('実行する？ [y/N]: ');
    if (!ok) {
      console.log('中止しました。');
      await run.finish({ freedBytes: 0, successCount: 0, errorCount: 0 });
      return;
    }
  }

  if (!jsonOutput) {
    if (dryRun) console.log('(dry-run: 実際には触りません)');
    console.log('\n🚀 実行中…');
  }

  const log = await execute(targets, { dryRun, purge });
  const logPath = await run.writeFile('log.json', serializeLog(log));

  // interactive で「次回から自動で消す」を選んだ項目を SAFE に昇格（学習）。
  // dry-run では学習も書かない（プレビューに徹する）。
  if (!dryRun && promotions.length > 0) {
    for (const p of promotions) {
      await upsertDecision({
        path: p,
        classification: 'SAFE',
        decidedAt: new Date().toISOString(),
        decidedBy: 'user',
        source: 'review-promote',
      });
    }
    if (!jsonOutput) console.log(`💡 ${promotions.length} 件を SAFE に昇格（次回から自動削除候補）`);
  }

  const successCount = log.entries.filter((e) => e.result === 'success').length;
  const errorCount = log.entries.filter((e) => e.result === 'error').length;
  const skippedCount = log.entries.filter((e) => e.result === 'skipped').length;

  // 実空き容量の更新
  const diskInfoAfter = await getDiskInfo();

  if (jsonOutput) {
    emitJson('clean-report', {
      runId: run.id,
      mode: purge ? 'purge' : 'trash',
      dryRun,
      targets: targets.map((t) => ({
        path: t.path,
        sizeBytes: t.sizeBytes,
        classification: t.classification,
        reason: t.reason,
        regenerable: t.regenerable,
        regenCost: t.regenCost,
      })),
      rejectedPaths,
      totalCandidateBytes: totalBytes,
      result: {
        successCount,
        errorCount,
        skippedCount,
        totalFreedBytes: log.totalFreedBytes,
        entries: log.entries,
      },
      diskInfo: {
        freeBytesBefore: diskInfoBefore.freeBytes,
        freeBytesAfter: diskInfoAfter.freeBytes,
        // ④ 全候補を回収した場合の空き見込み（trash は empty-trash 後に実現）
        projectedFreeBytes: projectedFreeBytes(diskInfoBefore.freeBytes, totalBytes),
      },
      logPath,
    });
  } else {
    console.log('');
    console.log(`✅ 成功: ${successCount} 件 / 解放: ${formatBytes(log.totalFreedBytes)}`);
    if (skippedCount > 0) console.log(`⚠️  スキップ: ${skippedCount} 件（除外パス検出）`);
    if (errorCount > 0) {
      console.log(`❌ エラー: ${errorCount} 件`);
      for (const e of log.entries.filter((x) => x.result === 'error').slice(0, 5)) {
        console.log(`   ${e.path}: ${e.errorMessage}`);
      }
    }

    // ゴミ箱経由の場合の警告
    if (!purge && !dryRun && log.totalFreedBytes > 0) {
      console.log('');
      console.log('💡 注意: ゴミ箱に移動しただけです。実際にディスクを解放するには:');
      console.log('   osascript -e \'tell application "Finder" to empty trash\'');
      console.log('   または Finder でゴミ箱を空にする');
    }

    console.log('');
    console.log(`📁 Run: ${run.id}`);
    console.log(`📄 ログ: ${logPath}`);
  }

  await run.finish({
    freedBytes: log.totalFreedBytes,
    successCount,
    errorCount,
    skippedCount,
    dryRun,
    mode: log.mode,
    freeBytesBefore: diskInfoBefore.freeBytes,
    freeBytesAfter: diskInfoAfter.freeBytes,
  });
}

async function cmdEmptyTrash(flags: Record<string, string | boolean>): Promise<void> {
  const dryRun = !!flags['dry-run'];
  const skipConfirm = !!flags['yes'];
  const jsonOutput = !!flags['json'];

  const run = await startRun('empty-trash', process.argv);
  const [contents, diskBefore] = await Promise.all([
    getTrashContents(),
    getDiskInfo(),
  ]);

  // 権限拒否でゴミ箱を読めない: 「空」と誤判定せず案内を出して終了 (偽成功を防ぐ)
  if (!contents.accessible) {
    if (jsonOutput) {
      emitJson('empty-trash-report', {
        runId: run.id,
        method: 'inaccessible',
        itemCount: 0,
        freedBytes: 0,
        dryRun,
        errorMessage: TRASH_INACCESSIBLE_GUIDANCE,
        diskInfo: { freeBytesBefore: diskBefore.freeBytes, freeBytesAfter: diskBefore.freeBytes },
      });
    } else {
      console.error(`⚠️  ${TRASH_INACCESSIBLE_GUIDANCE}`);
    }
    await run.finish({
      freedBytes: 0,
      successCount: 0,
      errorCount: 1,
      freeBytesBefore: diskBefore.freeBytes,
      freeBytesAfter: diskBefore.freeBytes,
    });
    process.exitCode = 1;
    return;
  }

  if (contents.itemCount === 0) {
    if (jsonOutput) {
      emitJson('empty-trash-report', {
        runId: run.id,
        method: 'noop',
        itemCount: 0,
        freedBytes: 0,
        dryRun,
        diskInfo: { freeBytesBefore: diskBefore.freeBytes, freeBytesAfter: diskBefore.freeBytes },
      });
    } else {
      console.log('✨ ゴミ箱は既に空です。');
    }
    await run.finish({
      freedBytes: 0,
      successCount: 0,
      errorCount: 0,
      freeBytesBefore: diskBefore.freeBytes,
      freeBytesAfter: diskBefore.freeBytes,
    });
    return;
  }

  if (!jsonOutput) {
    console.log(`🗑  ゴミ箱の内容: ${contents.itemCount} 項目 / ${formatBytes(contents.sizeBytes)}`);
    console.log(`   場所: ${contents.path}`);
    console.log('');
    console.log(`モード: ⚠️  完全削除（取り消し不可）`);
    console.log('');
  }

  if (!jsonOutput && !dryRun) {
    if (skipConfirm) {
      console.warn('⚠️  --yes 指定: 確認なしで実行します');
    } else {
      const ok = await confirm('ゴミ箱を空にする？ [y/N]: ');
      if (!ok) {
        console.log('中止しました。');
        await run.finish({
          freedBytes: 0,
          successCount: 0,
          errorCount: 0,
          dryRun: false,
          freeBytesBefore: diskBefore.freeBytes,
          freeBytesAfter: diskBefore.freeBytes,
        });
        return;
      }
    }
  }

  if (dryRun) {
    if (jsonOutput) {
      emitJson('empty-trash-report', {
        runId: run.id,
        method: 'dry-run',
        itemCount: contents.itemCount,
        freedBytes: contents.sizeBytes,
        dryRun: true,
        diskInfo: { freeBytesBefore: diskBefore.freeBytes, freeBytesAfter: diskBefore.freeBytes },
      });
    } else {
      console.log('(dry-run: 実際には触りません)');
      console.log('');
      console.log(`✅ 削除予定: ${contents.itemCount} 項目 / ${formatBytes(contents.sizeBytes)}`);
    }
    await run.finish({
      freedBytes: contents.sizeBytes,
      successCount: contents.itemCount,
      errorCount: 0,
      dryRun: true,
      freeBytesBefore: diskBefore.freeBytes,
      freeBytesAfter: diskBefore.freeBytes,
    });
    return;
  }

  if (!jsonOutput) console.log('\n🚀 実行中…');
  // contents を渡すことで emptyTrash 内の重複 getTrashContents() を回避
  const result = await emptyTrash({ contents });
  const diskAfter = await getDiskInfo();

  if (!result.success) {
    if (jsonOutput) {
      emitJson('empty-trash-report', {
        runId: run.id,
        method: result.method,
        itemCount: 0,
        freedBytes: 0,
        success: false,
        errorMessage: result.errorMessage,
        dryRun: false,
        diskInfo: { freeBytesBefore: diskBefore.freeBytes, freeBytesAfter: diskAfter.freeBytes },
      });
    } else {
      console.log(`❌ 失敗: ${result.errorMessage ?? '不明なエラー'}`);
      console.log('');
      console.log('💡 手動で空にする方法:');
      console.log('   osascript -e \'tell application "Finder" to empty trash\'');
    }
    await run.finish({
      freedBytes: 0,
      successCount: 0,
      errorCount: 1,
      dryRun: false,
      freeBytesBefore: diskBefore.freeBytes,
      freeBytesAfter: diskAfter.freeBytes,
    });
    return;
  }

  const freedReported = Math.max(result.freedBytes, diskAfter.freeBytes - diskBefore.freeBytes);

  if (jsonOutput) {
    emitJson('empty-trash-report', {
      runId: run.id,
      method: result.method,
      itemCount: contents.itemCount,
      freedBytes: freedReported,
      success: true,
      dryRun: false,
      diskInfo: { freeBytesBefore: diskBefore.freeBytes, freeBytesAfter: diskAfter.freeBytes },
    });
  } else {
    console.log(`✅ 完了 / 解放: ${formatBytes(freedReported)}`);
    console.log(`   ディスク空き: ${formatBytes(diskBefore.freeBytes)} → ${formatBytes(diskAfter.freeBytes)}`);
    console.log(`📁 Run: ${run.id}`);
  }

  await run.finish({
    freedBytes: freedReported,
    successCount: contents.itemCount,
    errorCount: 0,
    dryRun: false,
    freeBytesBefore: diskBefore.freeBytes,
    freeBytesAfter: diskAfter.freeBytes,
  });
}

async function cmdDiff(flags: Record<string, string | boolean>): Promise<void> {
  const jsonOutput = !!flags['json'];
  const prev = await loadLatestSnapshot();
  if (!prev) {
    if (jsonOutput) {
      emitJson('diff-report', { error: 'no-previous-snapshot', runId: null, diff: null });
    } else {
      console.log('スナップショットがまだありません。先に `molt scan` を実行してください。');
    }
    return;
  }
  if (!jsonOutput) console.log('🔍 現在のディスク状況をスキャン中…');
  const run = await startRun('diff', process.argv);
  const [scanned, diskInfo] = await Promise.all([scan(), getDiskInfo()]);
  const curr = buildSnapshot(scanned, diskInfo);
  const diff = diffSnapshots(prev, curr);

  // 比較用 snapshot も保存
  await run.writeFile('snapshot.json', serializeSnapshot(curr));

  if (jsonOutput) {
    emitJson('diff-report', {
      runId: run.id,
      prevTimestamp: prev.timestamp,
      currTimestamp: curr.timestamp,
      freeBytesDelta: diff.freeBytesDelta,
      diff,
    });
    await run.finish();
    return;
  }

  const sign = diff.freeBytesDelta >= 0 ? '+' : '';
  console.log('');
  console.log(`💾 空き容量変化: ${sign}${formatBytes(Math.abs(diff.freeBytesDelta))}`);
  console.log(`   前回: ${prev.timestamp}`);
  console.log(`   今回: ${curr.timestamp}`);
  console.log('');

  if (diff.added.length > 0) {
    console.log(`🆕 新規 (${diff.added.length} 件):`);
    for (const a of diff.added.slice(0, 20)) {
      console.log(`   ${formatBytes(a.sizeBytes).padStart(10)}  ${a.path}`);
    }
    console.log('');
  }
  if (diff.grown.length > 0) {
    console.log(`📈 肥大化 (${diff.grown.length} 件):`);
    for (const g of diff.grown.slice(0, 20)) {
      console.log(`   +${formatBytes(g.deltaBytes).padStart(9)}  ${g.path}`);
    }
    console.log('');
  }
  if (diff.shrunk.length > 0) {
    console.log(`📉 縮小 (${diff.shrunk.length} 件):`);
    for (const s of diff.shrunk.slice(0, 20)) {
      console.log(`   ${formatBytes(s.deltaBytes).padStart(10)}  ${s.path}`);
    }
    console.log('');
  }
  if (diff.removed.length > 0) {
    console.log(`🗑  消失 (${diff.removed.length} 件):`);
    for (const r of diff.removed.slice(0, 20)) {
      console.log(`   -${formatBytes(r.sizeBytes).padStart(9)}  ${r.path}`);
    }
    console.log('');
  }

  await run.finish();
  console.log(`📁 Run: ${run.id}`);
}

async function cmdHistory(flags: Record<string, string | boolean>): Promise<void> {
  const jsonOutput = !!flags['json'];
  const index = await loadIndex();

  if (jsonOutput) {
    emitJson('history-report', {
      totalRuns: index.runs.length,
      runs: [...index.runs].reverse(),
    });
    return;
  }

  if (index.runs.length === 0) {
    console.log('まだ履歴がありません。');
    return;
  }

  // 新しい順、最大 20 件
  const recent = [...index.runs].reverse().slice(0, 20);

  console.log(`📋 過去 ${recent.length} 件の実行履歴:\n`);
  console.log('  日時                  種別      解放        詳細');
  console.log('  ────────────────────  ────────  ──────────  ─────────────────────────');

  for (const r of recent) {
    const ts = new Date(r.startedAt).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const type = r.type.padEnd(8);
    const freed = r.freedBytes !== undefined ? formatBytes(r.freedBytes).padStart(10) : '         -';
    const detail: string[] = [];
    if (r.successCount !== undefined) detail.push(`成功 ${r.successCount}`);
    if (r.errorCount !== undefined && r.errorCount > 0) detail.push(`エラー ${r.errorCount}`);
    if (r.dryRun) detail.push('(dry-run)');
    if (r.mode === 'purge') detail.push('(purge)');
    console.log(`  ${ts}  ${type}  ${freed}  ${detail.join(' / ')}`);
  }

  console.log(`\n総 run 数: ${index.runs.length} 件`);
}

async function cmdForget(positional: string[]): Promise<void> {
  const path = positional[0];
  if (!path) {
    console.error('使い方: molt forget <path>');
    process.exit(1);
  }
  const removed = await removeDecision(path);
  if (removed) {
    console.log(`✅ 学習データから削除: ${path}`);
  } else {
    console.log(`⚠️  該当判定なし: ${path}`);
  }
}

async function cmdDecide(positional: string[]): Promise<void> {
  const [path, classification] = positional;
  if (!path || !classification) {
    console.error('使い方: molt decide <path> <SAFE|CAREFUL|DANGER>');
    process.exit(1);
  }
  if (!['SAFE', 'CAREFUL', 'DANGER'].includes(classification)) {
    console.error('classification は SAFE / CAREFUL / DANGER のいずれか');
    process.exit(1);
  }
  await upsertDecision({
    path,
    classification: classification as 'SAFE' | 'CAREFUL' | 'DANGER',
    decidedAt: new Date().toISOString(),
    decidedBy: 'user',
    source: 'cli',
  });
  console.log(`✅ 判定保存: ${path} → ${classification}`);
}

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────

async function confirm(message: string): Promise<boolean> {
  process.stdout.write(message);
  for await (const line of console) {
    return line.trim().toLowerCase() === 'y';
  }
  return false;
}

// ─────────────────────────────────────────
// interactive review (v0.2)
// ─────────────────────────────────────────

/**
 * review 候補の見出しサマリーと「内容」説明。ruleName 引き。
 * 表示文言は CLI 層の責務（core は分類セマンティクスのみ持つ）。
 */
const REVIEW_LABELS: Readonly<Record<string, { summary: string; note: string }>> = {
  'core-simulator-devices': {
    summary: 'iOS開発シミュレータ本体',
    note: 'インストール済みアプリ・設定・データが入る。消すと各シムが空になり、次回アプリを入れ直せば復活。',
  },
  'xcode-ios-device-support': {
    summary: '古いiOS版の実機デバッグシンボル',
    note: '実機デバッグ時に Xcode が作る古いiOS版シンボル。その実機を再接続すれば自動再生成。今使ってない端末なら不要。',
  },
  'android-system-image': {
    summary: 'Androidエミュレータイメージ',
    note: 'Android エミュレータのシステムイメージ。SDK Manager で再ダウンロード可。',
  },
  'node-modules': {
    summary: 'プロジェクト依存パッケージ',
    note: 'npm/yarn install で復元できる依存。消すと再 install に時間がかかる。',
  },
};

/** regenCost を「失うもの」の人間向け文言へ。 */
function regenCostLabel(cost?: string): string {
  switch (cost) {
    case 'auto': return '次回アクセスで自動再生成';
    case 'redownload': return '再ダウンロード';
    case 'rebuild': return '再ビルドで復元';
    case 'reinstall': return 'アプリ/環境を再インストール';
    default: return '再生成可';
  }
}

/** 1 行入力を読む（trim 前の生文字列）。 */
async function promptLine(message: string): Promise<string> {
  process.stdout.write(message);
  for await (const line of console) {
    return line;
  }
  return '';
}

/** [y/N/a/q] を読み、invalid なら再入力を促す。 */
async function promptReview(message: string): Promise<ReviewAnswer> {
  // 無限ループは TTY 入力で必ず確定する。invalid のみ再入力。
  while (true) {
    const ans = interpretReviewAnswer(await promptLine(message));
    if (ans !== 'invalid') return ans;
    console.log('   y / N / a / q で答えてください。');
  }
}

/**
 * regenerable な CAREFUL を1件ずつ対話レビューし、承認分と SAFE 昇格対象を返す。
 * - y: 削除セットに追加（現役なら二段確認 → 昇格を任意で確認）
 * - N: スキップ / a: 以降すべて追加 / q: 以降中断
 */
async function runInteractiveReview(
  classified: ReadonlyArray<ClassifiedPath>,
): Promise<{ approved: ClassifiedPath[]; promotions: string[] }> {
  const candidates = selectReviewCandidates(classified);
  const approved: ClassifiedPath[] = [];
  const promotions: string[] = [];

  if (candidates.length === 0) {
    console.log('\n📊 レビュー対象なし（再生成可な CAREFUL 項目は見つかりませんでした）。');
    return { approved, promotions };
  }

  console.log('\n📊 削除候補レビュー — 消せるが要判断の項目を1件ずつ確認します');
  const now = Date.now();
  let acceptAll = false;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const label = REVIEW_LABELS[c.ruleName ?? ''] ?? { summary: c.ruleName ?? 'CAREFUL 項目', note: c.reason };
    const active = isActive(c, 7, now);

    console.log('\n──────────────────────────────────────────────');
    console.log(`[${i + 1}/${candidates.length}] ⚠️  ${label.summary}      ${formatBytes(c.sizeBytes)}`);
    console.log(`   📂 ${c.path.replace(HOME, '~')}`);
    console.log(`   📝 内容: ${label.note}`);
    console.log(`   ♻️ 失うもの: ${regenCostLabel(c.regenCost)}${active ? '   🔥 現役(7日内更新)' : ''}`);

    if (acceptAll) {
      approved.push(c);
      console.log('   ✓ 追加 (a=全部)');
      continue;
    }

    const ans = await promptReview('   削除セットに入れる? [y/N/a=全部/q=中断]: ');
    if (ans === 'quit') { console.log('   — 中断（以降スキップ）'); break; }
    if (ans === 'no') { console.log('   — スキップ'); continue; }
    if (ans === 'all') { acceptAll = true; approved.push(c); console.log('   ✓ 追加（以降も全部）'); continue; }

    // yes: 現役なら二段確認
    if (active) {
      const ok2 = await confirm('     ⚠️ 現役だけど本当に消す? [y/N]: ');
      if (!ok2) { console.log('   — スキップ（現役を保護）'); continue; }
    }
    approved.push(c);
    console.log(`   ✓ 追加 ${formatBytes(c.sizeBytes)}`);

    const promote = await confirm('   💡 次回から自動で消す?(SAFE昇格・学習) [y/N]: ');
    if (promote) promotions.push(c.path);
  }

  return { approved, promotions };
}

// ─────────────────────────────────────────
// エントリ
// ─────────────────────────────────────────

async function main(): Promise<void> {
  const { command, positional, flags } = parseFlags(process.argv);
  // v0.1.0 リネーム移行: 旧 cleanup-mac の設定/データを moltmac へ引き継ぐ（新dir作成前に実行）
  const migrated = migrateLegacyDirs();
  if (migrated.length > 0) {
    // stderr に出すので --json の stdout envelope は汚さない
    console.error(`ℹ️  旧 cleanup-mac のデータを moltmac へ移行しました (${migrated.length}件)`);
  }
  await ensureStorageDirs();

  switch (command) {
    case 'scan':
      await cmdScan(flags);
      break;
    case 'clean':
      await cmdClean(flags);
      break;
    case 'empty-trash':
      await cmdEmptyTrash(flags);
      break;
    case 'diff':
      await cmdDiff(flags);
      break;
    case 'history':
      await cmdHistory(flags);
      break;
    case 'forget':
      await cmdForget(positional);
      break;
    case 'decide':
      await cmdDecide(positional);
      break;
    case 'help':
    case '--help':
    case '-h':
      await cmdHelp();
      break;
    default:
      console.error(`未知のコマンド: ${command}`);
      await cmdHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('❌ エラー:', e instanceof Error ? e.message : e);
  if (process.env['DEBUG']) console.error(e);
  process.exit(1);
});
