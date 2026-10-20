import { describe, expect, it } from "vitest";
import {
  RECOVERY_LOCK_MS,
  RECOVERY_LOCK_THRESHOLD,
  recoveryLocked,
} from "../../src/auth/recovery.ts";
import type { AuthEventKind } from "../../src/auth/types.ts";

const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

type Ev = { kind: AuthEventKind; occurredAt: string };
/** 古い順に並べた kind から、1 分間隔のイベントを作る（返す配列は新しい順） */
const events = (...kinds: AuthEventKind[]): Ev[] =>
  kinds.map((kind, i) => ({ kind, occurredAt: at(i * MIN) })).reverse();
const fail = (n: number): AuthEventKind[] =>
  Array.from({ length: n }, () => "recovery_failed" as const);

describe("recoveryLocked（R7）", () => {
  it("定数: 5 回、15 分", () => {
    expect(RECOVERY_LOCK_THRESHOLD).toBe(5);
    expect(RECOVERY_LOCK_MS).toBe(15 * MIN);
  });

  it("記録がなければ未ロック", () => {
    expect(recoveryLocked([], at(0))).toBe(false);
  });

  it("4 回の失敗は未ロック、5 回でロック", () => {
    expect(recoveryLocked(events(...fail(4)), at(4 * MIN))).toBe(false);
    expect(recoveryLocked(events(...fail(5)), at(5 * MIN))).toBe(true);
    expect(recoveryLocked(events(...fail(9)), at(9 * MIN))).toBe(true);
  });

  it("最後の失敗から 15 分未満はロック、15 分たてば解ける", () => {
    const evs = events(...fail(5)); // 最後の失敗は 4 分
    const last = 4 * MIN;
    expect(recoveryLocked(evs, at(last + 15 * MIN - 1))).toBe(true);
    expect(recoveryLocked(evs, at(last + 15 * MIN))).toBe(false);
    expect(recoveryLocked(evs, at(last + 60 * MIN))).toBe(false);
  });

  it("間に recovery_used が入ると連続が切れる", () => {
    expect(recoveryLocked(events(...fail(5), "recovery_used", ...fail(4)), at(20 * MIN))).toBe(
      false,
    );
    // 切れた後にさらに 5 回失敗すればロック
    expect(recoveryLocked(events(...fail(5), "recovery_used", ...fail(5)), at(20 * MIN))).toBe(
      true,
    );
    // 成功の後に失敗が 4 回だけなら、その前の 5 回があっても未ロック
    expect(recoveryLocked(events(...fail(5), "recovery_used"), at(6 * MIN))).toBe(false);
  });

  it("関係のない種類のイベントは連続を切らない", () => {
    const evs = events(
      "recovery_failed",
      "sign_in",
      "recovery_failed",
      "sign_in_failed",
      ...fail(3),
    );
    expect(recoveryLocked(evs, at(10 * MIN))).toBe(true);
  });

  it("入力の並びに依存しない（時刻順に並べ直す）", () => {
    const evs = events(...fail(5));
    expect(recoveryLocked([...evs].reverse(), at(5 * MIN))).toBe(true);
    const mixed = events(...fail(5), "recovery_used", ...fail(2));
    expect(recoveryLocked([...mixed].reverse(), at(10 * MIN))).toBe(false);
  });
});
