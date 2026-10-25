/**
 * bench（`bench-reports.ts`・`bench-import.ts`・`bench-backup.ts`）と `freee-import-runner.ts` の共通部品。
 * しきい値の環境変数の読み取り、実時計・実 ID、ベンチ用の事業体の作成、終了コードの扱い。
 */
import { randomUUIDv7 } from "node:crypto";
import { createTestEntity } from "../../packages/db/src/testing.ts";
import type { Clock, EntityProfile, IdGenerator } from "../../packages/domain/src/index.ts";

/** 環境変数 `name` の正の数（未設定・空なら fallback）。正の数でなければ例外 */
export function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} は正の数: ${raw}`);
  return value;
}

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
