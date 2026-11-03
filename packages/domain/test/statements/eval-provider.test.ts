import { describe, expect, it, vi } from "vitest";
import {
  createEvalProviderGuard,
  EvalProviderError,
} from "../../../../scripts/lib/eval-provider.ts";
import type { SuggestionProvider } from "../../src/ports.ts";
import { evaluateStatementScenes } from "../../src/statements/eval-runner.ts";
import { domainError, err, ok } from "../../src/types.ts";
import {
  createStatementEvalCase,
  STATEMENT_EVAL_ACCOUNTS,
  STATEMENT_EVAL_SPLIT_DATE,
} from "../fixtures/statements/statement-evals.ts";

const context = { accounts: [], taxCategories: [] };
const payload = {
  date: "2026-01-01",
  amount: 100,
  direction: "out" as const,
  content: "secret input",
  categoryMajor: null,
  categoryMinor: null,
  accountKind: "bank" as const,
  accountUsage: "mixed" as const,
};
const provider = (message: string): SuggestionProvider => ({
  available: async () => true,
  suggest: vi.fn(async () => err(domainError("VALIDATION", message))),
});

describe("評価CLI専用のprovider guard", () => {
  it.each([
    ["AI がエラーを返しました（HTTP 401）", "http", 401],
    ["AI がエラーを返しました（HTTP 429）", "http", 429],
    ["AI の応答が時間内に返りませんでした", "timeout", undefined],
    ["AI に接続できません", "connection", undefined],
    ["AI の応答を読めません", "response_read", undefined],
    ["AI の応答に本文がありません", "response_empty", undefined],
    ["https://secret.invalid key=secret response=secret", "provider", undefined],
    ["toString", "provider", undefined],
  ])("安全な分類だけを返す: %s", async (message, kind, status) => {
    const wrapped = createEvalProviderGuard(() => {})(provider(message as string), "external");
    const caught = await wrapped.suggest(payload, context).catch((e) => e);
    expect(caught).toBeInstanceOf(EvalProviderError);
    expect(caught).toMatchObject({ route: "external", kind, status });
    expect(caught.message).not.toContain("secret");
    expect(caught.cause).toBeUndefined();
  });
  it("最初の失敗で後続推定と保存に進まない", async () => {
    const local = provider("AI に接続できません");
    const external = provider("AI に接続できません");
    const guard = createEvalProviderGuard(() => {});
    const save = vi.fn();
    const evaluation = evaluateStatementScenes(
      [
        createStatementEvalCase("a", "2026-01-01", "合成広告A"),
        createStatementEvalCase("b", "2026-01-02", "合成広告B"),
      ],
      {
        local: guard(local, "local"),
        external: guard(external, "external"),
        externalEnabled: true,
        models: { local: "", external: "" },
      },
      {
        ledgerAccounts: STATEMENT_EVAL_ACCOUNTS,
        splitDate: STATEMENT_EVAL_SPLIT_DATE,
        threshold: 80,
      },
    ).then(save);
    await expect(evaluation).rejects.toMatchObject({ route: "local", kind: "connection" });
    expect(local.suggest).toHaveBeenCalledTimes(1);
    expect(external.suggest).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it("例外と利用不可も本文を捨てて経路だけを残す", async () => {
    const original = provider("");
    original.suggest = async () => {
      throw new Error("secret key and endpoint");
    };
    const wrapped = createEvalProviderGuard(() => {})(original, "local");
    await expect(wrapped.suggest(payload, context)).rejects.toMatchObject({
      route: "local",
      kind: "exception",
      message: "AI評価失敗: local exception",
    });
    original.available = async () => false;
    await expect(wrapped.available()).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("正常な呼出の前後は件数だけを通知し、schema不正はnone採点を維持する", async () => {
    const original = provider("");
    original.suggest = vi.fn(async () => ok({ secret: "invalid schema" }));
    const progress = vi.fn();
    const guard = createEvalProviderGuard(progress);
    const result = await evaluateStatementScenes(
      [createStatementEvalCase("a", "2026-01-01", "合成広告A")],
      {
        local: guard(original, "local"),
        external: guard(original, "external"),
        externalEnabled: false,
        models: { local: "", external: "" },
      },
      {
        ledgerAccounts: STATEMENT_EVAL_ACCOUNTS,
        splitDate: STATEMENT_EVAL_SPLIT_DATE,
        threshold: 80,
      },
    );
    expect(progress.mock.calls).toEqual([
      ["started", 1],
      ["completed", 1],
    ]);
    expect(result.scenes[0]?.result.methods[0]?.method).toBe("none");
  });
});
