import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type EvalFields,
  type EvalInfer,
  type EvalSample,
  evaluate,
} from "../../src/statements/evals.ts";
import { normalizeContent } from "../../src/statements/normalize.ts";

// 006 T026（R17）。評価の採点の純関数

const fields = (over: Partial<EvalFields> = {}): EvalFields => ({
  counterAccountId: "rent",
  taxCategory: "PURCHASE_10",
  partnerId: null,
  purpose: "business",
  ...over,
});

let seq = 0;
const sample = (
  content: string,
  date: string,
  truth: Partial<EvalFields> = {},
  statementAccountId = "bank",
): EvalSample => {
  seq += 1;
  return {
    statementId: `s${seq}`,
    date,
    statementAccountId,
    normalizedContent: normalizeContent(content),
    truth: fields(truth),
  };
};

const noneInfer: EvalInfer = async () => ({ method: "none", fields: null });

describe("evaluate: 基準日より前から学び、以後を推定する", () => {
  it("ルールに一致した明細は rule、一致しない明細は infer の結果（なければ none）で数える", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10"),
      sample("ショップ002", "2025-05-11"),
      sample("ショップ003", "2026-02-01"), // rule: 一致
      sample("別の店", "2026-02-02"), // rule なし → none
    ];
    const r = await evaluate(samples, "2026-01-01", noneInfer);
    expect(r.sampleCount).toBe(2);
    expect(r.fields).toEqual({ counterAccount: 500, taxCategory: 500, partner: 500, purpose: 500 });
    expect(r.methods).toEqual([
      { method: "rule", count: 1, matchRate: 1000 },
      { method: "none", count: 1, matchRate: 0 },
    ]);
  });

  it("項目ごとに数える: 相手の科目だけ違えば、科目は不一致で、ほかの項目は一致。全項目の一致が方法ごとの率", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10"),
      sample("ショップ002", "2026-02-01", { counterAccountId: "supplies" }),
    ];
    const r = await evaluate(samples, "2026-01-01", noneInfer);
    expect(r.fields).toEqual({
      counterAccount: 0,
      taxCategory: 1000,
      partner: 1000,
      purpose: 1000,
    });
    expect(r.methods).toEqual([{ method: "rule", count: 1, matchRate: 0 }]);
  });

  it("基準日以後の明細は学習に使わない（同じ内容が基準日以後に 2 件あっても、2 件目にルールはない）", async () => {
    const samples = [sample("ショップ001", "2026-02-01"), sample("ショップ002", "2026-02-02")];
    const calls: string[] = [];
    const r = await evaluate(samples, "2026-01-01", async (s) => {
      calls.push(s.statementId);
      return { method: "none", fields: null };
    });
    expect(calls).toHaveLength(2);
    expect(r.methods).toEqual([{ method: "none", count: 2, matchRate: 0 }]);
  });

  it("infer を呼ぶのは基準日以後でルールのない明細だけ。AI の方法と項目がそのまま数えられる", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10"),
      sample("ショップ002", "2026-02-01"),
      sample("別の店", "2026-02-02"),
      sample("別の店", "2026-02-03", { counterAccountId: "supplies" }),
    ];
    const called: string[] = [];
    const r = await evaluate(samples, "2026-01-01", async (s) => {
      called.push(s.normalizedContent);
      return { method: "local_ai", fields: fields({ counterAccountId: "rent" }) };
    });
    expect(called).toEqual([normalizeContent("別の店"), normalizeContent("別の店")]);
    expect(r.sampleCount).toBe(3);
    expect(r.methods).toEqual([
      { method: "rule", count: 1, matchRate: 1000 },
      { method: "local_ai", count: 2, matchRate: 500 },
    ]);
    expect(r.fields.counterAccount).toBe(667);
  });

  it("口座ごとにルールを学ぶ（別の口座で学んだルールは使わない）", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10", {}, "card"),
      sample("ショップ002", "2026-02-01", {}, "bank"),
    ];
    const r = await evaluate(samples, "2026-01-01", noneInfer);
    expect(r.methods).toEqual([{ method: "none", count: 1, matchRate: 0 }]);
  });

  it("同じ内容を違う内容で承認していたら、最後の承認の内容が学習される", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10", { counterAccountId: "rent" }),
      sample("ショップ002", "2025-06-10", { counterAccountId: "supplies" }),
      sample("ショップ003", "2026-02-01", { counterAccountId: "supplies" }),
    ];
    const r = await evaluate(samples, "2026-01-01", noneInfer);
    expect(r.methods).toEqual([{ method: "rule", count: 1, matchRate: 1000 }]);
  });

  it("対象が 0 件なら、件数 0・率はすべて 0・方法は空", async () => {
    const r = await evaluate([sample("ショップ001", "2025-05-10")], "2026-01-01", noneInfer);
    expect(r).toEqual({
      sampleCount: 0,
      fields: { counterAccount: 0, taxCategory: 0, partner: 0, purpose: 0 },
      methods: [],
    });
    const empty = await evaluate([], "2026-01-01", noneInfer);
    expect(empty.sampleCount).toBe(0);
  });

  it("率は千分率の整数（1/3 → 333、2/3 → 667）", async () => {
    const samples = [
      sample("ショップ001", "2025-05-10"),
      sample("ショップ002", "2026-02-01"),
      sample("ショップ003", "2026-02-02", { counterAccountId: "supplies" }),
      sample("ショップ004", "2026-02-03", { counterAccountId: "supplies" }),
    ];
    const r = await evaluate(samples, "2026-01-01", noneInfer);
    expect(r.fields.counterAccount).toBe(333);
  });

  it("性質: どんな入力でも率は 0〜1000 の整数で、方法ごとの件数の合計が sampleCount", async () => {
    const accountArb = fc.constantFrom("rent", "supplies", "travel");
    const sampleArb = fc.record({
      content: fc.constantFrom("ショップ001", "店B", "店C"),
      day: fc.integer({ min: 1, max: 28 }),
      before: fc.boolean(),
      account: accountArb,
      partner: fc.constantFrom(null, "p1"),
      purpose: fc.constantFrom("business" as const, "private" as const),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(sampleArb, { maxLength: 30 }), async (rows) => {
        const samples = rows.map((r) =>
          sample(r.content, `${r.before ? "2025" : "2026"}-03-${String(r.day).padStart(2, "0")}`, {
            counterAccountId: r.account,
            partnerId: r.partner,
            purpose: r.purpose,
          }),
        );
        const result = await evaluate(samples, "2026-01-01", noneInfer);
        for (const v of Object.values(result.fields)) {
          expect(Number.isInteger(v) && v >= 0 && v <= 1000).toBe(true);
        }
        expect(result.methods.reduce((sum, m) => sum + m.count, 0)).toBe(result.sampleCount);
        for (const m of result.methods) {
          expect(Number.isInteger(m.matchRate) && m.matchRate >= 0 && m.matchRate <= 1000).toBe(
            true,
          );
        }
      }),
    );
  });
});
