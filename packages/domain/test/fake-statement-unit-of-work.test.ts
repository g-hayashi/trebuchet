import { describe, expect, it } from "vitest";
import type { SuggestionPayload } from "../src/ports.ts";
import { ok } from "../src/types.ts";
import { FakeSuggestionProvider } from "./fakes.ts";

// fakeStatementUnitOfWork の巻き戻し・入れ子の run は fake-unit-of-work.test.ts の全機能共通の契約で確かめる

const EMPTY_PAYLOAD: SuggestionPayload = {
  scene: "statement",
  date: "2026-05-10",
  amount: 1,
  direction: "out",
  content: "",
  categoryMajor: null,
  categoryMinor: null,
  accountKind: "bank",
  accountUsage: "business",
};

describe("FakeSuggestionProvider", () => {
  it("available と suggest の応答を差し替えられ、呼び出しを記録する", async () => {
    const provider = new FakeSuggestionProvider({ available: true });
    expect(await provider.available()).toBe(true);
    provider.respondWith(ok({ accountCode: "6200" }));
    const payload = { ...EMPTY_PAYLOAD, amount: 500 };
    const context = { accounts: [], taxCategories: [] };
    const r = await provider.suggest(payload, context);
    expect(r).toEqual(ok({ accountCode: "6200" }));
    expect(provider.calls).toEqual([{ payload, context }]);
  });

  it("既定は使えない（available が false、suggest は失敗）", async () => {
    const provider = new FakeSuggestionProvider();
    expect(await provider.available()).toBe(false);
    const r = await provider.suggest(EMPTY_PAYLOAD, { accounts: [], taxCategories: [] });
    expect(r.ok).toBe(false);
  });
});
