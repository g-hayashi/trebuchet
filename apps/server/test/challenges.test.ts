import { describe, expect, it } from "vitest";
import { CHALLENGE_MAX, CHALLENGE_TTL_MS, ChallengeStore } from "../src/lib/challenges.ts";
import {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../src/lib/recovery-code.ts";

// T008: challenge の保持（5分・最大100件・単回）と回復コードの形

function makeClock() {
  let ms = Date.parse("2026-10-20T00:00:00.000Z");
  return {
    now: () => new Date(ms).toISOString(),
    advance: (d: number) => {
      ms += d;
    },
  };
}

describe("ChallengeStore", () => {
  it("同じ用途で 1 回だけ取り出せる", () => {
    const store = new ChallengeStore(makeClock());
    store.issue("register", "a");
    expect(store.consume("register", "a")).toBe(true);
    expect(store.consume("register", "a")).toBe(false);
  });

  it("用途の不一致は false で、そのまま破棄される", () => {
    const store = new ChallengeStore(makeClock());
    store.issue("register", "a");
    expect(store.consume("sign-in", "a")).toBe(false);
    expect(store.consume("register", "a")).toBe(false);
  });

  it("5 分で期限が切れる", () => {
    const clock = makeClock();
    const store = new ChallengeStore(clock);
    store.issue("register", "a");
    store.issue("register", "b");
    clock.advance(CHALLENGE_TTL_MS - 1);
    expect(store.consume("register", "a")).toBe(true);
    clock.advance(1);
    expect(store.consume("register", "b")).toBe(false);
  });

  it("100 件を超えたら古いものから捨てる", () => {
    const store = new ChallengeStore(makeClock());
    for (let i = 0; i < CHALLENGE_MAX + 1; i++) store.issue("register", `c${i}`);
    expect(store.size).toBe(CHALLENGE_MAX);
    expect(store.consume("register", "c0")).toBe(false);
    expect(store.consume("register", "c1")).toBe(true);
    expect(store.consume("register", `c${CHALLENGE_MAX}`)).toBe(true);
  });
});

describe("回復コード", () => {
  it("128 ビット（26 文字）を Crockford の base32 で 4 文字ずつ区切る", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}-[0-9A-HJKMNP-TV-Z]{2}$/,
    );
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it("先頭の文字は 3 ビット分だけ（0〜7）", () => {
    for (let i = 0; i < 50; i++) expect("01234567").toContain(generateRecoveryCode()[0]);
  });

  it("小文字・区切りの有無・空白・I/L/O の読み替えを同じコードとして扱う", () => {
    const code = generateRecoveryCode();
    expect(normalizeRecoveryCode(code.toLowerCase().replaceAll("-", " "))).toBe(
      normalizeRecoveryCode(code),
    );
    expect(normalizeRecoveryCode("0O-1I-1L")).toBe("00" + "11" + "11");
    expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code.toLowerCase()));
  });
});
