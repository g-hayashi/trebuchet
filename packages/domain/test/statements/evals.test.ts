import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type EvalFields,
  type EvalInfer,
  type EvalSample,
  evaluate,
} from "../../src/statements/evals.ts";
import { buildAiPayload } from "../../src/statements/mask.ts";
import { normalizeContent } from "../../src/statements/normalize.ts";
import { ok } from "../../src/types.ts";
import { listEvalRuns, runEvaluation } from "../../src/usecases/evals.ts";
import { approveCandidate, excludeStatement } from "../../src/usecases/statement-approval.ts";
import { buildCandidates } from "../../src/usecases/statements.ts";
import { FakeSuggestionProvider } from "../fakes.ts";
import { type StatementsCtx, setupStatements, unwrap } from "../statements-setup.ts";

// 006 T026（R17、§1.9、FR-029、SC-004）。評価の計算（純関数）と、評価の実行・保存

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

describe("runEvaluation", () => {
  let ctx: StatementsCtx;
  let local: FakeSuggestionProvider;
  let external: FakeSuggestionProvider;
  const evalDeps = (over: { externalEnabled?: boolean } = {}) => ({
    ...ctx.deps,
    local,
    external,
    externalEnabled: over.externalEnabled ?? true,
    models: { local: "local-model", external: "external-model" },
  });
  const rentCode = () => ctx.masters.listAccounts().find((a) => a.name === "地代家賃")?.code ?? "";
  const approveAs = (content: string, counterId: string) => {
    const id = ctx.idOf(content);
    unwrap(approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "business", counterId) }));
  };

  beforeEach(() => {
    ctx = setupStatements();
    local = new FakeSuggestionProvider({ available: true });
    external = new FakeSuggestionProvider({ available: true });
    ctx.mapAll();
    // 2025: 学習用。2026: 評価の対象（ルールの一致が正解、不正解、ルールなし）
    ctx.importRows(
      [
        ctx.row({ content: "ショップ001", date: "2025-05-10", amount: -1200 }),
        ctx.row({ content: "ショップ002", date: "2025-05-20", amount: -1300 }),
      ],
      2025,
    );
    ctx.importRows([
      ctx.row({ content: "ショップ003", date: "2026-02-01", amount: -1400 }),
      ctx.row({ content: "ショップ004", date: "2026-02-02", amount: -1500 }),
      ctx.row({ content: "別の店", date: "2026-02-03", amount: -1600 }),
      ctx.row({ content: "未処理の店", date: "2026-02-04", amount: -1700 }),
      ctx.row({ content: "除外の店", date: "2026-02-05", amount: -1800 }),
    ]);
    approveAs("ショップ001", ctx.a.rent);
    approveAs("ショップ002", ctx.a.rent);
    approveAs("ショップ003", ctx.a.rent);
    approveAs("ショップ004", ctx.a.supplies);
    approveAs("別の店", ctx.a.rent);
    unwrap(excludeStatement(ctx.deps, ctx.idOf("除外の店"), {}));
    // AI の既定の応答は「別の店」の正解（科目・税区分・判定）と同じにする
    const link = ctx.activeLinks(ctx.idOf("別の店"))[0];
    const journal = ctx.ledger.getJournal(link?.journalId ?? "");
    const counter = journal?.lines.find((l) => l.id !== link?.journalLineId);
    local.respondWith(
      ok({
        accountCode: rentCode(),
        taxCategory: counter?.taxCategory,
        purpose: "business",
        confidence: 80,
        reason: "家賃",
      }),
    );
  });

  const snapshot = () => ({
    rules: structuredClone(ctx.uow.statements.state.rules),
    candidates: structuredClone(ctx.uow.statements.state.candidates),
    links: structuredClone(ctx.uow.statements.state.links),
    journals: ctx.ledger.findJournals({ dateFrom: "2000-01-01", dateTo: "2100-01-01", limit: 500 })
      .items,
  });

  it("登録済みの明細だけを評価する（未処理・除外は対象外）。基準日の既定は今年の 1 月 1 日。AI なしは none", async () => {
    const run = unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31" }));
    expect(run.splitDate).toBe("2026-01-01");
    expect(run.includeAi).toBe(false);
    expect(run.sampleCount).toBe(3);
    expect(run.models).toEqual([]);
    expect(run.result.methods).toEqual([
      { method: "rule", count: 2, matchRate: 500 },
      { method: "none", count: 1, matchRate: 0 },
    ]);
    // ルール 2 件のうち 1 件が科目一致
    expect(run.result.fields.counterAccount).toBe(333);
    expect(local.calls).toHaveLength(0);
    expect(external.calls).toHaveLength(0);
    expect(run.id).not.toBe("");
    expect(run.createdAt).toBe(ctx.clock.now());
  });

  it("保存する（新しい順に並ぶ）。基準日を指定できる", async () => {
    const first = unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31" }));
    ctx.clock.value = "2026-11-01T00:00:00.000Z";
    const second = unwrap(
      await runEvaluation(evalDeps(), { today: "2026-11-01", splitDate: "2026-02-03" }),
    );
    expect(second.splitDate).toBe("2026-02-03");
    expect(second.sampleCount).toBe(1);
    const runs = unwrap(listEvalRuns({ uow: ctx.uow }));
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(runs[1]).toEqual(first);
  });

  it("DB のルール・候補・結びつき・仕訳を書き換えない", async () => {
    const before = snapshot();
    unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31", includeAi: true }));
    expect(snapshot()).toEqual(before);
  });

  it("includeAi: ルールのない明細だけ端末内の AI を呼ぶ。渡すのは buildAiPayload の結果。モデル名を記録する", async () => {
    const run = unwrap(
      await runEvaluation(evalDeps({ externalEnabled: false }), {
        today: "2026-10-31",
        includeAi: true,
      }),
    );
    expect(run.includeAi).toBe(true);
    expect(local.calls).toHaveLength(1);
    expect(external.calls).toHaveLength(0);
    const target = ctx.statements().find((s) => s.content === "別の店");
    const account = ctx.uow.statements.state.accounts.find((a) => a.name === "サンプル銀行");
    if (target === undefined || account === undefined) throw new Error("準備の誤り");
    expect(local.calls[0]?.payload).toEqual(buildAiPayload(target, account));
    expect(run.models).toEqual(["local-model"]);
    expect(run.result.methods).toEqual([
      { method: "rule", count: 2, matchRate: 500 },
      { method: "local_ai", count: 1, matchRate: 1000 },
    ]);
  });

  it("外部は有効（設定と使える状態）のときだけ呼ぶ。しきい値未満の端末内の結果は外部で置き換える", async () => {
    local.respondWith(
      ok({
        accountCode: rentCode(),
        taxCategory: "PURCHASE_10",
        purpose: "business",
        confidence: 10,
        reason: "弱い",
      }),
    );
    external.respondWith(
      ok({
        accountCode: rentCode(),
        taxCategory: "PURCHASE_10",
        purpose: "business",
        confidence: 90,
        reason: "強い",
      }),
    );
    unwrap(
      await runEvaluation(evalDeps({ externalEnabled: false }), {
        today: "2026-10-31",
        includeAi: true,
      }),
    );
    expect(external.calls).toHaveLength(0);

    external.setAvailable(false);
    unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31", includeAi: true }));
    expect(external.calls).toHaveLength(0);

    external.setAvailable(true);
    const run = unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31", includeAi: true }));
    expect(external.calls).toHaveLength(1);
    expect(run.models).toEqual(["local-model", "external-model"]);
    expect(run.result.methods.map((m) => m.method)).toEqual(["rule", "external_ai"]);
  });

  it("AI が使えない・使える出力がないときは none として数える", async () => {
    local.setAvailable(false);
    external.setAvailable(false);
    const run = unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31", includeAi: true }));
    expect(run.models).toEqual([]);
    expect(run.result.methods.map((m) => m.method)).toEqual(["rule", "none"]);
  });

  it("buildCandidates 済みの候補は評価で読み取らない・書かない（候補の件数が変わらない）", async () => {
    unwrap(buildCandidates(ctx.deps));
    const before = ctx.uow.statements.state.candidates.length;
    unwrap(await runEvaluation(evalDeps(), { today: "2026-10-31", includeAi: true }));
    expect(ctx.uow.statements.state.candidates).toHaveLength(before);
  });
});
