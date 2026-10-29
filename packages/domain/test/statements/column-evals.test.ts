import { describe, expect, it } from "vitest";
import type { ColumnSuggestionProvider } from "../../src/ports.ts";
import { buildColumnPrompt, hasRequiredColumns } from "../../src/statements/column-prompt.ts";
import { domainError, err, ok, type Result } from "../../src/types.ts";
import {
  COLUMN_TIMEOUT_DETAIL,
  type ColumnEvalCase,
  evaluateColumnSuggestions,
} from "../../src/usecases/statement-columns.ts";
import { COLUMN_EVAL_CASES } from "../fixtures/statements/column-evals.ts";

// 007 T018（R15、Constitution IV）。列の案の評価の集計と、評価の例の形。AI・fm は呼ばない（偽の provider）

/** 呼ばれた順に決めた応答を返す provider。呼ばれた要求も残す */
function scripted(responses: Result<unknown>[]): ColumnSuggestionProvider & { prompts: unknown[] } {
  const prompts: unknown[] = [];
  return {
    prompts,
    available: async () => true,
    async suggestColumns(prompt) {
      prompts.push(prompt);
      const next = responses[prompts.length - 1];
      return next ?? err(domainError("VALIDATION", "応答がありません"));
    },
  };
}

/** 役割 → 列の番号（例は 4 列）を、AI の出力の形（列ごとに役割 1 つ）にして返す */
const answer = (roles: Record<string, number>, amountSign: string | null = null) =>
  ok({
    roles: Array.from(
      { length: 4 },
      (_, index) => Object.entries(roles).find(([, i]) => i === index)?.[0] ?? "none",
    ),
    amountSign,
    confidence: 80,
  });

const caseOf = (
  name: string,
  columns: ColumnEvalCase["expected"]["columns"],
  amountSign?: "inflow_positive" | "outflow_positive",
): ColumnEvalCase => ({
  name,
  header: ["a", "b", "c", "d"],
  sampleRows: [["2026/10/01", "店", "1", "2"]],
  columnCount: 4,
  expected: amountSign === undefined ? { columns } : { columns, amountSign },
});

describe("evaluateColumnSuggestions", () => {
  const cases = [
    caseOf("A", { date: 0, content: 1, amount: 2 }, "inflow_positive"),
    caseOf("B", { date: 0, content: 1, outflow: 2, inflow: 3 }),
    caseOf("C", { date: 0, content: 1, amount: 2 }),
    caseOf("D", { date: 0, content: 1, amount: 2 }, "inflow_positive"),
  ];

  it("必須の役割がすべて正しい割合・役割ごとの一致率・案なしの割合・案なしの理由を千分率と件数で返す", async () => {
    const provider = scripted([
      answer({ date: 0, content: 1, amount: 2 }, "inflow_positive"), // A: すべて正しい
      answer({ date: 0, content: 1, outflow: 3, inflow: 2 }), // B: 出金と入金が逆
      err(domainError("VALIDATION", "時間切れ", COLUMN_TIMEOUT_DETAIL)), // C: 案なし（timeout）
      ok("JSON ではない"), // D: 案なし（invalid）
    ]);
    const result = await evaluateColumnSuggestions(cases, provider);
    expect(result.caseCount).toBe(4);
    expect(result.allRequiredRate).toBe(250);
    expect(result.noSuggestionRate).toBe(500);
    expect(result.unavailable).toEqual({ disabled: 0, unavailable: 0, timeout: 1, invalid: 1 });
    expect(result.roles).toEqual([
      { role: "date", count: 4, matchRate: 500 },
      { role: "content", count: 4, matchRate: 500 },
      { role: "amount", count: 3, matchRate: 333 },
      { role: "outflow", count: 1, matchRate: 0 },
      { role: "inflow", count: 1, matchRate: 0 },
    ]);
    expect(result.amountSign).toEqual({ count: 2, matchRate: 500 });
  });

  it("例ごとに必ず AI に尋ねる（辞書・保存した対応で足りる扱いにしない）。要求は buildColumnPrompt と同じ", async () => {
    const provider = scripted([]);
    await evaluateColumnSuggestions(cases, provider);
    expect(provider.prompts).toHaveLength(4);
    const [first] = cases;
    if (first === undefined) throw new Error("unreachable");
    expect(provider.prompts[0]).toEqual(buildColumnPrompt(first));
  });

  it("provider がなければすべて disabled の案なし", async () => {
    const result = await evaluateColumnSuggestions(cases, undefined);
    expect(result.noSuggestionRate).toBe(1000);
    expect(result.allRequiredRate).toBe(0);
    expect(result.unavailable.disabled).toBe(4);
  });

  it("使えない provider は unavailable、例外も unavailable に数える", async () => {
    const result = await evaluateColumnSuggestions(cases, {
      available: async () => false,
      suggestColumns: async () => ok(null),
    });
    expect(result.unavailable).toEqual({ disabled: 0, unavailable: 4, timeout: 0, invalid: 0 });
    const thrown = await evaluateColumnSuggestions(cases, {
      available: async () => true,
      suggestColumns: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.unavailable.unavailable).toBe(4);
  });

  it("すべて正しければ 1000。列の番号の余計な役割は必須の判定に影響しない", async () => {
    const provider = scripted([
      answer({ date: 0, content: 1, amount: 2, memo: 3 }, "inflow_positive"),
      answer({ date: 0, content: 1, outflow: 2, inflow: 3 }),
      answer({ date: 0, content: 1, amount: 2 }),
      answer({ date: 0, content: 1, amount: 2 }, "inflow_positive"),
    ]);
    const result = await evaluateColumnSuggestions(cases, provider);
    expect(result.allRequiredRate).toBe(1000);
    expect(result.noSuggestionRate).toBe(0);
    expect(result.amountSign).toEqual({ count: 2, matchRate: 1000 });
  });

  it("例が 0 件なら 0（割り算しない）", async () => {
    const result = await evaluateColumnSuggestions([], scripted([]));
    expect(result).toMatchObject({
      caseCount: 0,
      allRequiredRate: 0,
      noSuggestionRate: 0,
      roles: [],
    });
  });
});

describe("COLUMN_EVAL_CASES（評価の例）", () => {
  it("20 件以上で、名前が重ならない", () => {
    expect(COLUMN_EVAL_CASES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(COLUMN_EVAL_CASES.map((c) => c.name)).size).toBe(COLUMN_EVAL_CASES.length);
  });

  it("見出しなし・英語の見出しの例を含む", () => {
    expect(COLUMN_EVAL_CASES.some((c) => c.header === null)).toBe(true);
    expect(COLUMN_EVAL_CASES.some((c) => c.header?.some((h) => /^[A-Za-z]/.test(h)))).toBe(true);
  });

  it.each(COLUMN_EVAL_CASES.map((c) => [c.name, c] as const))(
    "%s: 列数が行・見出しと合い、正解の列は範囲内で重ならず、必須がそろう",
    (_name, c) => {
      expect(c.columnCount).toBeGreaterThan(0);
      if (c.header !== null) expect(c.header).toHaveLength(c.columnCount);
      expect(c.sampleRows.length).toBeGreaterThan(0);
      for (const row of c.sampleRows) expect(row).toHaveLength(c.columnCount);
      const indexes = Object.values(c.expected.columns);
      for (const index of indexes) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(c.columnCount);
      }
      expect(new Set(indexes).size).toBe(indexes.length);
      expect(hasRequiredColumns(c.expected.columns)).toBe(true);
      if (c.expected.amountSign !== undefined) expect(c.expected.columns.amount).toBeDefined();
    },
  );
});
