// getDiskInfo / parseDiskutilApfsList のテスト。
//
// APFS container 全体 (Data + System + VM + Preboot + Update) を集計するため、
// df ではなく diskutil apfs list の出力をパースする。

import { describe, expect, it } from 'bun:test';
import { parseDiskutilApfsList } from '../src/scanner.ts';

const FIXTURE = `
+-- Container disk3 12345678-...
|   ====================================================
|   APFS Container Reference:     disk3
|   Size (Capacity Ceiling):      494332366848 B (494.3 GB)
|   Capacity In Use By Volumes:   445919170560 B (445.9 GB) (90.2% used)
|   Capacity Not Allocated:       48413196288 B (48.4 GB) (9.8% free)
|   |
|   +-< Physical Store disk0s2 ...
|   |
|   +-> Volume disk3s1 ...
|       Capacity Consumed:         12191334400 B (12.2 GB)
|       Sealed:                    Yes
`;

describe('parseDiskutilApfsList', () => {
  it('container 全体の Size / In Use / Not Allocated をパースする', () => {
    const result = parseDiskutilApfsList(FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBe(494332366848);
    expect(result!.usedBytes).toBe(445919170560);
    expect(result!.freeBytes).toBe(48413196288);
  });

  it('合計が概ね Size と一致する (誤差 1% 以内)', () => {
    const result = parseDiskutilApfsList(FIXTURE);
    expect(result).not.toBeNull();
    const diff = Math.abs(result!.totalBytes - (result!.usedBytes + result!.freeBytes));
    expect(diff / result!.totalBytes).toBeLessThan(0.01);
  });

  it('期待フィールドが欠落すると null', () => {
    expect(parseDiskutilApfsList('garbage output')).toBeNull();
    expect(parseDiskutilApfsList('Size (Capacity Ceiling): 100 B')).toBeNull(); // 他の field 不足
  });

  it('空文字列は null', () => {
    expect(parseDiskutilApfsList('')).toBeNull();
  });

  it('数値が負値や 0 は弾く', () => {
    const bad = `
      Size (Capacity Ceiling):      0 B
      Capacity In Use By Volumes:   100 B
      Capacity Not Allocated:       100 B
    `;
    expect(parseDiskutilApfsList(bad)).toBeNull();
  });
});
