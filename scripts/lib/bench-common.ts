/**
 * bench（`bench-reports.ts`・`bench-import.ts`・`bench-backup.ts`・`bench-statements.ts`）と
 * `freee-import-runner.ts`（`pnpm verify:freee`・`verify:tax-return` の本体）の共通部品。
 * 実時計・実 ID、ベンチ用の事業体の作成、測定の集計、終了コードの扱い。環境変数の読み取りは `env.ts`。
 */
import { randomUUIDv7 } from "node:crypto";
import { createTestEntity } from "../../packages/db/src/testing.ts";
import type { Clock, EntityProfile, IdGenerator } from "../../packages/domain/src/index.ts";

/** 実 ID（UUIDv7）と実時計。bench は固定の時計を使わない */
export const benchIds: IdGenerator = { next: () => randomUUIDv7() };
export const benchClock: Clock = { now: () => new Date().toISOString() };

/**
 * ベンチ用の事業体（個人事業・1 月始まり）を作る。失敗は例外。
 * 呼ぶ前に `useTempDataDir` などでデータの置き場所を切り替えておくこと。
 */
export function createBenchEntity(options: {
  name: string;
  firstFiscalYear: number;
}): EntityProfile {
  return createTestEntity({ ...options, now: benchClock.now(), ids: benchIds });
}

/** 測定値（ミリ秒）の中央値と最大値（小数 1 桁に丸める） */
export function summarize(values: readonly number[]): { median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  const max = sorted[sorted.length - 1] ?? Number.NaN;
  return { median: Number(median.toFixed(1)), max: Number(max.toFixed(1)) };
}

/**
 * ウォームアップを 1 回してから `run`（所要ミリ秒を返す）を `runs` 回測り、中央値・最大値・判定を返す。
 * 判定は丸める前の最大値が `limitMs` 以下なら OK
 */
export async function measureStats(
  run: () => Promise<number>,
  runs: number,
  limitMs: number,
): Promise<{ median: number; max: number; result: "OK" | "NG" }> {
  await run(); // ウォームアップ
  const times: number[] = [];
  for (let i = 0; i < runs; i++) times.push(await run());
  const rawMax = Math.max(...times);
  return { ...summarize(times), result: rawMax <= limitMs ? "OK" : "NG" };
}

/**
 * bench の本体を実行する。本体が true を返したときだけ終了コード 0。
 * 例外は表示して終了コード 1。`cleanup`（一時のデータ場所の削除など）は必ず呼ぶ。
 */
export async function runBench(
  body: () => boolean | Promise<boolean>,
  cleanup: () => void,
): Promise<void> {
  let passed = false;
  try {
    passed = await body();
  } catch (error) {
    console.error(error);
  } finally {
    cleanup();
  }
  process.exitCode = passed ? 0 : 1;
}
