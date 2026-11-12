import { afterEach, describe, expect, it, vi } from "vitest";
import { errorName, isRecord, startInterval } from "../src/lib/util.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("errorName", () => {
  it("Error は名前だけ、それ以外は unknown（メッセージを出さない）", () => {
    expect(errorName(new TypeError("secret"))).toBe("TypeError");
    expect(errorName("boom")).toBe("unknown");
    expect(errorName(undefined)).toBe("unknown");
  });
});

describe("isRecord", () => {
  it("配列・null・プリミティブは false", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("startInterval", () => {
  it("間隔ごとに tick を呼び、返した関数で止まる", () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const stop = startInterval(tick, 1000);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
