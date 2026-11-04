import { describe, expect, it } from "vitest";
import type { SuggestionContext } from "../../src/ports.ts";
import type { Account } from "../../src/types.ts";
import { ok } from "../../src/types.ts";
import { createAiSuggester } from "../../src/usecases/inference.ts";
import { suggestJournalEntry } from "../../src/usecases/journal-ai-suggestion.ts";
import { FakeSuggestionProvider, fakeStatementUnitOfWork } from "../fakes.ts";
import { setupBase } from "../ledger-setup.ts";

// 011 T042（R19）。createAiSuggester は明細だけでなく、仕訳の入力（journal_entry の場面）も受ける。
// 送るのは buildJournalEntryPayload の結果（マスクした摘要・金額・日付）だけ

const account = (code: string, name: string): Account =>
  ({
    id: `acc-${code}`,
    code,
    name,
    isActive: true,
    isSystem: true,
  }) as unknown as Account;
const LEDGER = [account("5130", "広告宣伝費"), account("5120", "通信費")];
const CONTEXT: SuggestionContext = {
  accounts: [
    { code: "5130", name: "広告宣伝費" },
    { code: "5120", name: "通信費" },
  ],
  taxCategories: ["PURCHASE_10", "OUT_OF_SCOPE"],
};
const answer = (over: Record<string, unknown> = {}) =>
  ok({
    accountCode: "5120",
    taxCategory: "PURCHASE_10",
    purpose: "business",
    confidence: 90,
    reason: "通信費",
    ...over,
  });

function setup(externalEnabled = true) {
  const local = new FakeSuggestionProvider({ available: true });
  const external = new FakeSuggestionProvider({ available: true });
  const suggester = createAiSuggester(
    { local, external, externalEnabled, models: { local: "l", external: "e" } },
    { context: CONTEXT, ledgerAccounts: LEDGER, threshold: 80 },
  );
  return { local, external, suggester };
}

describe("createAiSuggester（journal_entry の場面）", () => {
  it("端末内に、マスクした摘要・金額・日付だけの payload を渡す", async () => {
    const { local, external, suggester } = setup();
    local.respondWith(answer());
    const outcome = await suggester.suggest({
      date: "2026-05-10",
      amount: 3300,
      memo: "通信費 カード 1234567890",
    });
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]?.payload).toEqual({
      scene: "journal_entry",
      date: "2026-05-10",
      amount: 3300,
      memo: "通信費 カード ####",
    });
    expect(external.calls).toHaveLength(0);
    expect(outcome?.suggestion?.method).toBe("local_ai");
    expect(outcome?.suggestion?.value).toMatchObject({
      accountCode: "5120",
      accountId: "acc-5120",
    });
  });

  it("端末内の確信度がしきい値より低いと外部へ進み、外部にも同じ payload を渡す", async () => {
    const { local, external, suggester } = setup();
    local.respondWith(answer({ confidence: 10 }));
    external.respondWith(answer({ accountCode: "5130" }));
    const outcome = await suggester.suggest({ date: "2026-05-10", amount: 500, memo: "広告" });
    expect(external.calls).toHaveLength(1);
    expect(external.calls[0]?.payload).toEqual(local.calls[0]?.payload);
    expect(outcome?.suggestion?.method).toBe("external_ai");
    expect(outcome?.suggestion?.value.accountId).toBe("acc-5130");
  });

  it("一覧にない科目の出力は候補なし（INV-46）", async () => {
    const { local, suggester } = setup();
    local.respondWith(answer({ accountCode: "9999" }));
    const outcome = await suggester.suggest({ date: "2026-05-10", amount: 500, memo: "広告" });
    expect(outcome?.suggestion).toBeNull();
    expect(outcome?.failure).not.toBe("");
  });
});

describe("suggestJournalEntry（011 T043）", () => {
  function usecase(over: { externalEnabled?: boolean; externalAvailable?: boolean } = {}) {
    const base = setupBase();
    const local = new FakeSuggestionProvider({ available: true });
    const external = new FakeSuggestionProvider({ available: over.externalAvailable ?? true });
    const deps = {
      uow: fakeStatementUnitOfWork(base.ledger, base.masters),
      clock: base.clock,
      local,
      external,
      externalEnabled: over.externalEnabled ?? true,
      models: { local: "l", external: "e" },
    };
    const code = base.masters.listAccounts().find((a) => a.name === "消耗品費")?.code ?? "";
    return { deps, local, external, code };
  }
  const input = { date: "2026-05-10", amount: 3300, memo: "コピー用紙 1234567" };

  it("外部の AI が無効（または使えない）なら AI_NOT_CONFIGURED。どちらの AI も呼ばない", async () => {
    for (const over of [{ externalEnabled: false }, { externalAvailable: false }]) {
      const t = usecase(over);
      const r = await suggestJournalEntry(t.deps, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AI_NOT_CONFIGURED");
      expect(t.local.calls).toHaveLength(0);
      expect(t.external.calls).toHaveLength(0);
    }
  });

  it("有効な科目の候補は AiSuggestion の形で返す（accountId は含めない）。摘要はマスクして送る", async () => {
    const t = usecase();
    t.local.respondWith(answer({ accountCode: t.code, confidence: 95 }));
    const r = await suggestJournalEntry(t.deps, input);
    expect(r).toEqual({
      ok: true,
      value: {
        suggestion: {
          accountCode: t.code,
          taxCategory: "PURCHASE_10",
          purpose: "business",
          confidence: 95,
          reason: "通信費",
        },
      },
    });
    expect(t.local.calls[0]?.payload).toMatchObject({ memo: "コピー用紙 ####" });
    // 文脈は科目のコードと名前・税区分のコードだけ（取引先・口座の名前は入らない）
    expect(Object.keys(t.local.calls[0]?.context ?? {}).sort()).toEqual([
      "accounts",
      "taxCategories",
    ]);
  });

  it("一覧にない科目は suggestion: null と理由（INV-46）", async () => {
    const t = usecase();
    t.local.respondWith(answer({ accountCode: "9999" }));
    const r = await suggestJournalEntry(t.deps, input);
    expect(r.ok && r.value.suggestion).toBeNull();
    expect(r.ok && r.value.reason).toEqual(expect.any(String));
  });
});
