import { describe, expect, it } from "vitest";
import { todayOf } from "../src/lib/today.ts";

const at = (iso: string) => ({ now: () => iso });

describe("todayOf（R22）", () => {
  it("timeZone を渡すと、その土地の暦日にする（UTC の 15:00 は JST の翌日 0 時）", () => {
    expect(todayOf(at("2026-10-25T15:30:00Z"), "Asia/Tokyo")).toBe("2026-10-26");
    expect(todayOf(at("2026-10-25T15:00:00Z"), "Asia/Tokyo")).toBe("2026-10-26");
    expect(todayOf(at("2026-10-25T14:59:00Z"), "Asia/Tokyo")).toBe("2026-10-25");
  });

  it("UTC では日付が変わらない時刻も、別のタイムゾーンでは暦日が違う", () => {
    expect(todayOf(at("2026-10-25T15:30:00Z"), "UTC")).toBe("2026-10-25");
    expect(todayOf(at("2026-10-25T02:00:00Z"), "America/Los_Angeles")).toBe("2026-10-24");
  });

  it("YYYY-MM-DD の形で返し、月・日はゼロ埋めする", () => {
    expect(todayOf(at("2026-01-05T03:00:00Z"), "Asia/Tokyo")).toBe("2026-01-05");
    expect(todayOf(at("2026-12-31T20:00:00Z"), "Asia/Tokyo")).toBe("2027-01-01");
  });

  it("timeZone を省略しても、実行環境の暦日（YYYY-MM-DD）を返す", () => {
    expect(todayOf(at("2026-10-25T12:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
