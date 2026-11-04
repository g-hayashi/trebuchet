import { describe, expect, it, vi } from "vitest";
import type { SuggestionProvider } from "../../src/ports.ts";
import { evaluateStatementScenes } from "../../src/statements/eval-runner.ts";
import { ok } from "../../src/types.ts";
import {
  createJournalEntryEvalCase,
  JOURNAL_ENTRY_EVAL_CASES,
} from "../fixtures/statements/journal-entry-evals.ts";
import {
  STATEMENT_EVAL_ACCOUNTS,
  STATEMENT_EVAL_CASES,
  STATEMENT_EVAL_SPLIT_DATE,
} from "../fixtures/statements/statement-evals.ts";

// 011 T045: 仕訳の入力の場面（journal_entry）の評価。明細の場面の集計は変えない

const answer = (over: Record<string, unknown> = {}) => ({
  accountCode: "5130",
  taxCategory: "PURCHASE_10",
  purpose: "business",
  confidence: 95,
  reason: "合成の回答",
  ...over,
});
const provider = (value: unknown): SuggestionProvider => ({
  available: vi.fn(async () => true),
  suggest: vi.fn(async () => ok(value)),
});
const run = (cases: Parameters<typeof evaluateStatementScenes>[0], local: SuggestionProvider) =>
  evaluateStatementScenes(
    cases,
    {
      local,
      external: provider(answer()),
      externalEnabled: true,
      models: { local: "secret-model", external: "secret-model" },
    },
    {
      ledgerAccounts: STATEMENT_EVAL_ACCOUNTS,
      splitDate: STATEMENT_EVAL_SPLIT_DATE,
      threshold: 80,
    },
  );

describe("仕訳の入力の評価の合成例（journal_entry）", () => {
  it("30件前後の合成例で、すべて採点用の期間にあり、明細の入力を持たない", () => {
    expect(JOURNAL_ENTRY_EVAL_CASES.length).toBeGreaterThanOrEqual(30);
    for (const c of JOURNAL_ENTRY_EVAL_CASES) {
      expect(c.scene).toBe("journal_entry");
      expect(c.sample.date >= STATEMENT_EVAL_SPLIT_DATE).toBe(true);
      expect(Object.keys(c.work).sort()).toEqual(["amount", "date", "memo"]);
    }
    const ids = JOURNAL_ENTRY_EVAL_CASES.map((c) => c.sample.statementId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("正解の科目は固定の評価用の科目表にあり、税区分と私用の別もそろう", () => {
    const codes = new Set(STATEMENT_EVAL_ACCOUNTS.map((a) => a.id));
    for (const c of JOURNAL_ENTRY_EVAL_CASES) {
      expect(codes.has(c.sample.truth.counterAccountId)).toBe(true);
      expect(["business", "private"]).toContain(c.sample.truth.purpose);
    }
  });
});

describe("evaluateStatementScenes: journal_entry の場面", () => {
  it("明細の場面の後ろに journal_entry の場面を別に集計し、AI へは日付・金額・マスク済みの摘要だけを送る", async () => {
    const local = provider(answer());
    const target = createJournalEntryEvalCase(
      "je-mask",
      "2026-02-01",
      "合成広告社 contact@example.invalid 98765432",
      11000,
    );
    const result = await run([target], local);
    expect(result.scenes.map((s) => s.scene)).toEqual(["journal_entry"]);
    expect(local.suggest).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(local.suggest).mock.calls[0]?.[0];
    expect(sent).toEqual({
      scene: "journal_entry",
      date: "2026-02-01",
      amount: 11000,
      memo: "合成広告社 [連絡先] ####",
    });
    expect(result.scenes[0]?.result).toMatchObject({
      sampleCount: 1,
      methods: [{ method: "local_ai", count: 1, matchRate: 1000 }],
    });
    const saved = JSON.stringify(result);
    for (const secret of ["contact@example.invalid", "98765432", "合成広告社", "je-mask"])
      expect(saved).not.toContain(secret);
  });

  it("日付・金額・科目の不一致を数え、科目が違えば一致率が下がる", async () => {
    const hit = createJournalEntryEvalCase("a", "2026-02-01", "合成費用A", 1000);
    const miss = createJournalEntryEvalCase("b", "2026-02-02", "合成費用B", 2000, "5120");
    const result = await run([hit, miss], provider(answer()));
    expect(result.scenes[0]?.result.methods).toEqual([
      { method: "local_ai", count: 2, matchRate: 500 },
    ]);
  });

  it("端末内の出力が不正なら外部へ進む", async () => {
    const target = createJournalEntryEvalCase("a", "2026-02-01", "合成費用A", 1000);
    const result = await run([target], provider(answer({ accountCode: "unknown" })));
    expect(result.scenes[0]?.result.methods[0]?.method).toBe("external_ai");
  });

  it("明細の場面の集計は journal_entry を足しても変わらない", async () => {
    const alone = await run(STATEMENT_EVAL_CASES, provider(answer()));
    const mixed = await run(
      [...STATEMENT_EVAL_CASES, ...JOURNAL_ENTRY_EVAL_CASES],
      provider(answer()),
    );
    expect(mixed.scenes.map((s) => s.scene)).toEqual(["statement", "journal_entry"]);
    expect(mixed.scenes[0]).toEqual(alone.scenes[0]);
    expect(mixed.scenes[1]?.result.sampleCount).toBe(JOURNAL_ENTRY_EVAL_CASES.length);
  });

  it("journal_entry の各件は端末内の AI へ 1 回だけ問い合わせ、ルールは使わない", async () => {
    const local = provider(answer());
    const result = await run(JOURNAL_ENTRY_EVAL_CASES, local);
    expect(local.suggest).toHaveBeenCalledTimes(JOURNAL_ENTRY_EVAL_CASES.length);
    expect(result.scenes[0]?.result.methods.map((m) => m.method)).toEqual(["local_ai"]);
  });
});
