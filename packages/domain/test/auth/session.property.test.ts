import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSessionActive, RECOVERY_SESSION_MS, SESSION_IDLE_MS } from "../../src/auth/session.ts";

// 2000-01-01 〜 2100-01-01（ミリ秒）
const timeArb = fc.integer({ min: 946_684_800_000, max: 4_102_444_800_000 });
const iso = (ms: number) => new Date(ms).toISOString();
const kindArb = fc.constantFrom("normal" as const, "recovery" as const);

const sessionOf = (
  kind: "normal" | "recovery",
  createdMs: number,
  seenMs: number,
  revokedAt: string | null,
) => ({ kind, createdAt: iso(createdMs), lastSeenAt: iso(seenMs), revokedAt });

describe("isSessionActive（INV-28）", () => {
  it("定数は 8 時間と 10 分", () => {
    expect(SESSION_IDLE_MS).toBe(8 * 60 * 60 * 1000);
    expect(RECOVERY_SESSION_MS).toBe(10 * 60 * 1000);
  });

  it("revoked_at があれば、時刻にかかわらず無効", () => {
    fc.assert(
      fc.property(kindArb, timeArb, timeArb, timeArb, timeArb, (kind, created, seen, now, rev) => {
        expect(isSessionActive(sessionOf(kind, created, seen, iso(rev)), iso(now))).toBe(false);
      }),
    );
  });

  it("normal: 最後の操作から 8 時間以上で無効、未満で（未失効なら）有効", () => {
    fc.assert(
      fc.property(
        timeArb,
        fc.integer({ min: 0, max: 3 * SESSION_IDLE_MS }),
        timeArb,
        (seen, elapsed, created) => {
          const s = sessionOf("normal", created, seen, null);
          expect(isSessionActive(s, iso(seen + elapsed))).toBe(elapsed < SESSION_IDLE_MS);
        },
      ),
    );
  });

  it("recovery: 作成から 10 分以上で無効、未満で（未失効なら）有効（最後の操作は無関係）", () => {
    fc.assert(
      fc.property(
        timeArb,
        fc.integer({ min: 0, max: 3 * RECOVERY_SESSION_MS }),
        timeArb,
        (created, elapsed, seen) => {
          const s = sessionOf("recovery", created, seen, null);
          expect(isSessionActive(s, iso(created + elapsed))).toBe(elapsed < RECOVERY_SESSION_MS);
        },
      ),
    );
  });

  it("境界: ちょうど 8 時間・10 分は無効、1ms 手前は有効", () => {
    const t = 1_800_000_000_000;
    const n = sessionOf("normal", t, t, null);
    expect(isSessionActive(n, iso(t + SESSION_IDLE_MS - 1))).toBe(true);
    expect(isSessionActive(n, iso(t + SESSION_IDLE_MS))).toBe(false);
    const r = sessionOf("recovery", t, t, null);
    expect(isSessionActive(r, iso(t + RECOVERY_SESSION_MS - 1))).toBe(true);
    expect(isSessionActive(r, iso(t + RECOVERY_SESSION_MS))).toBe(false);
  });
});
