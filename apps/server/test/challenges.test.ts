import { describe, expect, it } from "vitest";
import { CHALLENGE_MAX, CHALLENGE_TTL_MS, ChallengeStore } from "../src/lib/challenges.ts";
import { makeClock } from "./helpers.ts";

// T008: challenge の保持（5分・最大100件・単回）。008: 登録の途中の値（PRF の salt など）を一緒に持つ

const START = "2026-10-20T00:00:00.000Z";

describe("ChallengeStore", () => {
  it("同じ用途で 1 回だけ取り出せる", () => {
    const store = new ChallengeStore(makeClock(START));
    store.issue("register", "a");
    expect(store.take("register", "a")).toBeDefined();
    expect(store.take("register", "a")).toBeUndefined();
  });

  it("用途の不一致は undefined で、そのまま破棄される", () => {
    const store = new ChallengeStore(makeClock(START));
    store.issue("register", "a");
    expect(store.take("sign-in", "a")).toBeUndefined();
    expect(store.take("register", "a")).toBeUndefined();
  });

  it("5 分で期限が切れる", () => {
    const clock = makeClock(START);
    const store = new ChallengeStore(clock);
    store.issue("register", "a");
    store.issue("register", "b");
    clock.advance(CHALLENGE_TTL_MS - 1);
    expect(store.take("register", "a")).toBeDefined();
    clock.advance(1);
    expect(store.take("register", "b")).toBeUndefined();
  });

  it("100 件を超えたら古いものから捨てる", () => {
    const store = new ChallengeStore(makeClock(START));
    for (let i = 0; i < CHALLENGE_MAX + 1; i++) store.issue("register", `c${i}`);
    expect(store.take("register", "c0")).toBeUndefined();
    expect(store.take("register", "c1")).toBeDefined();
    expect(store.take("register", `c${CHALLENGE_MAX}`)).toBeDefined();
  });

  it("take は一緒に入れた値を 1 回だけ返す。用途の不一致・期限切れは undefined で破棄する", () => {
    const clock = makeClock(START);
    const store = new ChallengeStore(clock);
    store.issue("register", "a", { salt: 1 });
    store.issue("register", "b", { salt: 2 });
    store.issue("register", "c");
    expect(store.take("register", "a")).toEqual({ data: { salt: 1 } });
    expect(store.take("register", "a")).toBeUndefined();
    expect(store.take("sign-in", "b")).toBeUndefined();
    expect(store.take("register", "b")).toBeUndefined();
    expect(store.take("register", "c")).toEqual({ data: undefined });
    store.issue("register", "d", 4);
    clock.advance(CHALLENGE_TTL_MS);
    expect(store.take("register", "d")).toBeUndefined();
  });
});
