import { describe, expect, it, vi } from "vitest";
import type { SuggestionProvider } from "../../src/ports.ts";
import { evaluateStatementScenes } from "../../src/statements/eval-runner.ts";
import { domainError, err, ok } from "../../src/types.ts";
import {
  createStatementEvalCase,
  STATEMENT_EVAL_ACCOUNTS,
  STATEMENT_EVAL_CASES,
  STATEMENT_EVAL_SPLIT_DATE,
} from "../fixtures/statements/statement-evals.ts";

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
const run = (
  cases: ReturnType<typeof createStatementEvalCase>[],
  local: SuggestionProvider,
  external = provider(answer()),
  externalEnabled = true,
) =>
  evaluateStatementScenes(
    cases,
    {
      local,
      external,
      externalEnabled,
      models: { local: "secret-model", external: "secret-model" },
    },
    {
      ledgerAccounts: STATEMENT_EVAL_ACCOUNTS,
      splitDate: STATEMENT_EVAL_SPLIT_DATE,
      threshold: 80,
    },
  );

describe("明細CLI評価の純粋runner", () => {
  it("合成fixtureは学習4件と採点16件に分かれ、ルール4件とAI12件を採点する", async () => {
    const local = provider(answer());
    const result = await run(STATEMENT_EVAL_CASES, local);
    expect(result.scenes[0]?.result.sampleCount).toBe(16);
    expect(result.scenes[0]?.result.methods.find((m) => m.method === "rule")?.count).toBe(4);
    expect(local.suggest).toHaveBeenCalledTimes(12);
  });
  it("学習用から作ったルールを優先し、採点用だけを数える", async () => {
    const local = provider(answer());
    const training = createStatementEvalCase("train", "2025-12-01", "合成通信費");
    const target = createStatementEvalCase("target", "2026-01-01", "合成通信費");
    const result = await run([training, target], local);
    expect(local.suggest).not.toHaveBeenCalled();
    expect(result.scenes[0]?.result).toMatchObject({
      sampleCount: 1,
      methods: [{ method: "rule", count: 1, matchRate: 1000 }],
    });
  });
  it("端末内の低確信度から外部へ進み、sceneごとに集計して本文を残さない", async () => {
    const local = provider(answer({ confidence: 20 }));
    const external = provider(answer());
    const target = createStatementEvalCase(
      "target",
      "2026-01-01",
      "合成連絡 user@example.invalid 12345678",
    );
    const result = await run([target, { ...target, scene: "future_scene" }], local, external);
    expect(local.suggest).toHaveBeenCalledTimes(2);
    expect(external.suggest).toHaveBeenCalledTimes(2);
    expect(local.suggest).toHaveBeenCalledWith(
      expect.objectContaining({ content: "合成連絡 [連絡先] ####" }),
      expect.anything(),
    );
    expect(result.scenes.map((s) => s.scene)).toEqual(["statement", "future_scene"]);
    expect(result.scenes[0]?.result.methods).toEqual([
      { method: "external_ai", count: 1, matchRate: 1000 },
    ]);
    const saved = JSON.stringify(result);
    for (const secret of ["user@example.invalid", "12345678", "target", "secret-model", "合成連絡"])
      expect(saved).not.toContain(secret);
    expect(result.ai).toMatchObject({ localCalls: 2, externalCalls: 2, failures: 0 });
  });
  it("外部無効では低確信度の端末内結果を使い、外部を調べない", async () => {
    const external = provider(answer());
    const result = await run(
      [createStatementEvalCase("a", "2026-01-01", "合成費用")],
      provider(answer({ confidence: 10 })),
      external,
      false,
    );
    expect(external.available).not.toHaveBeenCalled();
    expect(result.scenes[0]?.result.methods[0]?.method).toBe("local_ai");
    expect(result.ai.externalEnabled).toBe(false);
  });
  it("確信度が十分なら外部へ送らず、端末内の出力が不正なら外部へ進む", async () => {
    const external = provider(answer());
    const cases = [createStatementEvalCase("a", "2026-01-01", "合成費用")];
    await run(cases, provider(answer()), external);
    expect(external.suggest).not.toHaveBeenCalled();
    const result = await run(cases, provider(answer({ accountCode: "unknown" })), external);
    expect(external.suggest).toHaveBeenCalledTimes(1);
    expect(result.scenes[0]?.result.methods[0]?.method).toBe("external_ai");
  });
  it("接続失敗の本文を集計に残さず、失敗件数を記録する", async () => {
    const failed = provider(answer());
    failed.suggest = async () => err(domainError("VALIDATION", "secret endpoint and key"));
    const result = await run(
      [createStatementEvalCase("a", "2026-01-01", "合成費用")],
      failed,
      provider(answer()),
      false,
    );
    expect(result.ai.failures).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each([{ accountCode: "unknown" }, { taxCategory: "invalid" }])(
    "不正なAI出力を候補なしにする: %s",
    async (invalid) => {
      const result = await run(
        [createStatementEvalCase("a", "2026-01-01", "合成費用")],
        provider(answer(invalid)),
        provider(answer()),
        false,
      );
      expect(result.scenes[0]?.result.methods).toEqual([
        { method: "none", count: 1, matchRate: 0 },
      ]);
    },
  );
  it("journalShapeが私用口座の私用を仕訳なしにする", async () => {
    const target = createStatementEvalCase("a", "2026-01-01", "合成私用");
    target.work.account.usage = "private";
    const result = await run(
      [target],
      provider(answer({ purpose: "private" })),
      provider(answer()),
      false,
    );
    expect(result.scenes[0]?.result.methods[0]?.method).toBe("none");
  });
  it("AIが使えない状態と接続失敗を件数で区別する", async () => {
    const unavailable = provider(answer());
    unavailable.available = async () => false;
    const target = createStatementEvalCase("a", "2026-01-01", "合成費用");
    const result = await run([target], unavailable, unavailable);
    expect(result.ai).toMatchObject({
      localUnavailable: 1,
      externalUnavailable: 1,
      localCalls: 0,
      externalCalls: 0,
    });
    const throwing = provider(answer());
    throwing.suggest = async () => {
      throw new Error("secret endpoint");
    };
    await expect(run([target], throwing)).rejects.toThrow();
  });
});
