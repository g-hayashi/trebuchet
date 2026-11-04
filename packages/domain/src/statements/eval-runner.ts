import { TaxCategoryCode } from "@trebuchet/schema";
import type { SuggestionProvider } from "../ports.ts";
import type { Account } from "../types.ts";
import { type AiWork, createAiSuggester, type InferenceDeps } from "../usecases/inference.ts";
import { type EvalPrediction, type EvalResult, type EvalSample, evaluate } from "./evals.ts";
import { journalShape } from "./journal-shape.ts";
import type { JournalEntryInput } from "./mask.ts";
import { counterAccounts } from "./prompt.ts";

/** 合成の正解と本番と同じ推定入力。sceneは後続の場面を追加できる識別子。 */
export type StatementEvalCase = { scene: string; sample: EvalSample; work: AiWork };
/**
 * 仕訳の入力の場面（011/R19）。入力は日付・金額・摘要だけで、明細・口座・仕訳の形は持たない。
 * 同じ集計の枠で場面として数えるが、明細の場面の件数・一致率には混ざらない
 */
export type JournalEntryEvalCase = {
  scene: "journal_entry";
  sample: EvalSample;
  work: JournalEntryInput;
};
export type EvalCase = StatementEvalCase | JournalEntryEvalCase;
export type StatementSceneEvaluation = {
  scenes: { scene: string; result: EvalResult }[];
  /** 件数だけを保存する。モデル・入力・回答・失敗の本文を含めない。 */
  ai: {
    externalEnabled: boolean;
    localCalls: number;
    externalCalls: number;
    localUnavailable: number;
    externalUnavailable: number;
    failures: number;
  };
};

/** I/Oはproviderに限り、帳簿・registry・候補を読み書きしない評価runner。 */
export async function evaluateStatementScenes(
  cases: readonly EvalCase[],
  deps: Pick<InferenceDeps, "local" | "external" | "externalEnabled" | "models">,
  options: { ledgerAccounts: readonly Account[]; splitDate: string; threshold: number },
): Promise<StatementSceneEvaluation> {
  const ai: StatementSceneEvaluation["ai"] = {
    externalEnabled: deps.externalEnabled,
    localCalls: 0,
    externalCalls: 0,
    localUnavailable: 0,
    externalUnavailable: 0,
    failures: 0,
  };
  const counted = (
    provider: SuggestionProvider,
    kind: "local" | "external",
  ): SuggestionProvider => ({
    async available() {
      const ready = await provider.available();
      if (!ready) ai[kind === "local" ? "localUnavailable" : "externalUnavailable"] += 1;
      return ready;
    },
    async suggest(payload, context) {
      ai[kind === "local" ? "localCalls" : "externalCalls"] += 1;
      const result = await provider.suggest(payload, context);
      if (!result.ok) ai.failures += 1;
      return result;
    },
  });
  const scenes: StatementSceneEvaluation["scenes"] = [];
  for (const scene of new Set(cases.map((c) => c.scene))) {
    const selected = cases.filter((c) => c.scene === scene);
    const works = new Map(selected.map((c) => [c.sample.statementId, c.work]));
    const suggester = createAiSuggester(
      {
        ...deps,
        local: counted(deps.local, "local"),
        external: counted(deps.external, "external"),
      },
      {
        ledgerAccounts: options.ledgerAccounts,
        threshold: options.threshold,
        context: {
          accounts: counterAccounts(options.ledgerAccounts).map((a) => ({
            code: a.code,
            name: a.name,
          })),
          taxCategories: TaxCategoryCode.options,
        },
      },
    );
    const result = await evaluate(
      selected.map((c) => c.sample),
      options.splitDate,
      async (sample): Promise<EvalPrediction> => {
        const work = works.get(sample.statementId);
        if (work === undefined) throw new Error("評価入力がありません");
        const outcome = await suggester.suggest(work);
        const suggestion = outcome?.suggestion;
        const none: EvalPrediction = { method: "none", fields: null };
        if (suggestion == null) return none;
        const s = suggestion.value;
        // 仕訳の入力: 明細の口座・仕訳の形はないので、AI の候補の科目・税区分・私用の別をそのまま採点する
        if (!("record" in work)) {
          return {
            method: suggestion.method,
            fields: {
              counterAccountId: s.accountId,
              taxCategory: s.taxCategory,
              partnerId: null,
              purpose: s.purpose,
            },
          };
        }
        const shaped = journalShape({
          statement: work.record,
          account: work.account,
          purpose: s.purpose,
          counter: { accountId: s.accountId, taxCategory: s.taxCategory },
          accounts: options.ledgerAccounts,
        });
        if (!shaped.ok || shaped.value === null) return none;
        const { draft, statementLineIndex } = shaped.value;
        const counter = draft.lines.find((_, i) => i !== statementLineIndex);
        if (counter === undefined) return none;
        return {
          method: suggestion.method,
          fields: {
            counterAccountId: counter.accountId,
            taxCategory: counter.taxCategory ?? s.taxCategory,
            partnerId: counter.partnerId ?? null,
            purpose: s.purpose,
          },
        };
      },
    );
    scenes.push({ scene, result });
  }
  return { scenes, ai };
}
