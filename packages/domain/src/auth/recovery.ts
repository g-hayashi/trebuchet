import type { AuthEvent } from "./types.ts";

/** 連続した失敗がこの回数以上でロックする（R7） */
export const RECOVERY_LOCK_THRESHOLD = 5;
/** 最後の失敗からこの時間でロックが解ける */
export const RECOVERY_LOCK_MS = 15 * 60 * 1000;

/**
 * 回復コードの入力がロック中か（R7）。`now` は ISO 8601。
 * 直近の連続した `recovery_failed`（`recovery_used` で連続が切れる。他の種類は無視）が
 * 5 回以上、かつ最後の失敗から 15 分未満。ロック中の試行は記録されないので、ロックは延びない。
 * 入力は時刻の新しい順を想定する（同時刻の並びはその順を保つ）。
 */
export function recoveryLocked(
  events: readonly Pick<AuthEvent, "kind" | "occurredAt">[],
  now: string,
): boolean {
  const newestFirst = events
    .map((e, i) => ({ e, i, t: Date.parse(e.occurredAt) }))
    .sort((a, b) => b.t - a.t || a.i - b.i);
  let failures = 0;
  let lastFailureMs: number | undefined;
  for (const { e, t } of newestFirst) {
    if (e.kind === "recovery_used") break;
    if (e.kind !== "recovery_failed") continue;
    failures += 1;
    lastFailureMs ??= t;
  }
  if (failures < RECOVERY_LOCK_THRESHOLD || lastFailureMs === undefined) return false;
  return Date.parse(now) - lastFailureMs < RECOVERY_LOCK_MS;
}
