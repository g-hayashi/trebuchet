import { type EvalRun, TaxCategoryCode } from "@trebuchet/schema";
import { isValidDate } from "../dates.ts";
import type { IdGenerator, StatementUnitOfWork } from "../ports.ts";
import {
  type EvalInfer,
  type EvalPrediction,
  type EvalResult,
  type EvalSample,
  evaluate,
  truthOf,
} from "../statements/evals.ts";
import { journalShape } from "../statements/journal-shape.ts";
import { counterAccounts } from "../statements/prompt.ts";
import { type EvalRunRecord, ok, type Result, validation } from "../types.ts";
import { type AiOutcome, type AiWork, createAiSuggester, type InferenceDeps } from "./inference.ts";
import { loadStatementStates } from "./statement-candidates.ts";
import { DEFAULT_STATEMENT_SETTINGS } from "./statements.ts";

// 評価の実行と保存（006 US5。R17、§1.9、FR-029、SC-004）。評価はルール・候補・結びつき・仕訳を書き換えない。
// 書くのは `eval_runs` の 1 行だけ。AI の呼び出しは遅いので、`StatementUnitOfWork` の外で await する
// （読む → 評価 → 書く）。AI に渡す内容は推定と同じ `buildAiPayload`（`createAiSuggester`）を通す

export type EvalDeps = InferenceDeps & { ids: IdGenerator };

export type EvalInput = {
  /** 基準日（これより前の承認からルールを作り、以後を推定する）。省略は今年の 1 月 1 日 */
  splitDate?: string | undefined;
  /** AI（端末内、外部は設定で有効なときだけ）を含める。省略は含めない */
  includeAi?: boolean | undefined;
  /** 今日（`YYYY-MM-DD`）。既定の基準日に使う */
  today: string;
};

const NONE: EvalPrediction = { method: "none", fields: null };

/** 保存した行を API の形にする */
export function toEvalRun(record: EvalRunRecord): EvalRun {
  return {
    id: record.id,
    splitDate: record.splitDate,
    includeAi: record.includeAi,
    sampleCount: record.sampleCount,
    result: JSON.parse(record.resultJson) as EvalRun["result"],
    models: JSON.parse(record.modelsJson) as string[],
    createdAt: record.createdAt,
  };
}

/** AI の出力から、仕訳の案の相手の行（候補を作るときと同じ形）を取り出して評価の項目にする */
function aiPrediction(
  work: AiWork,
  outcome: AiOutcome | undefined,
  ledgerAccounts: Parameters<typeof journalShape>[0]["accounts"],
): EvalPrediction {
  const suggestion = outcome?.suggestion;
  if (suggestion === null || suggestion === undefined) return NONE;
  const s = suggestion.value;
  const shaped = journalShape({
    statement: work.record,
    account: work.account,
    purpose: s.purpose,
    counter: { accountId: s.accountId, taxCategory: s.taxCategory },
    accounts: ledgerAccounts,
  });
  if (!shaped.ok || shaped.value === null) return NONE;
  const { draft, statementLineIndex } = shaped.value;
  const counter = draft.lines.find((_, i) => i !== statementLineIndex);
  if (counter === undefined) return NONE;
  return {
    method: suggestion.method,
    fields: {
      counterAccountId: counter.accountId,
      taxCategory: counter.taxCategory ?? s.taxCategory,
      partnerId: counter.partnerId ?? null,
      purpose: s.purpose,
    },
  };
}

/**
 * 評価を実行して `eval_runs` に保存する。評価の対象は、有効な結びつきが 1 つ（`created`・`matched`）で、
 * 仕訳が有効な 2 行（明細の行と相手の行）の登録済みの明細（訂正・取消済み・分割の仕訳は正解にできないので除く）。
 * 基準日より前の承認から（メモリだけで）ルールを作り、基準日以後の明細を推定して正解と比べる。
 * `includeAi` のとき、ルールが当たらない明細に AI を使う（端末内 → 外部。外部は設定で有効で使えるときだけ）。
 * AI が使えない・使える出力がなければ none として数える。`StatementRecord` の候補は読まない・書かない
 */
export async function runEvaluation(deps: EvalDeps, input: EvalInput): Promise<Result<EvalRun>> {
  const splitDate = input.splitDate ?? `${input.today.slice(0, 4)}-01-01`;
  if (!isValidDate(splitDate)) {
    return validation("基準日が日付として正しくありません", { field: "splitDate" });
  }
  const includeAi = input.includeAi === true;

  // 1. 読む
  const read = deps.uow.run((tx) => {
    const ledgerAccounts = tx.masters.listAccounts();
    const stAccounts = new Map(tx.statements.listStatementAccounts().map((a) => [a.id, a]));
    const samples: EvalSample[] = [];
    const works = new Map<string, AiWork>();
    for (const state of loadStatementStates(tx)) {
      const [link, ...rest] = state.activeLinks;
      if (state.status !== "registered" || link === undefined || rest.length > 0) continue;
      const journal = tx.ledger.getJournal(link.journalId);
      const account = stAccounts.get(state.record.statementAccountId);
      if (journal === undefined || account === undefined) continue;
      const truth = truthOf(journal, link.journalLineId, ledgerAccounts);
      if (truth === null) continue;
      samples.push({
        statementId: state.record.id,
        date: state.record.date,
        statementAccountId: state.record.statementAccountId,
        normalizedContent: state.record.normalizedContent,
        truth,
      });
      works.set(state.record.id, { record: state.record, account });
    }
    const threshold =
      tx.statements.getStatementSettings()?.externalThreshold ??
      DEFAULT_STATEMENT_SETTINGS.externalThreshold;
    return ok({ samples, works, ledgerAccounts, threshold });
  });
  if (!read.ok) return read;
  const { samples, works, ledgerAccounts, threshold } = read.value;

  // 2. 評価する（AI は UnitOfWork の外）
  const suggester = createAiSuggester(deps, {
    context: {
      accounts: counterAccounts(ledgerAccounts).map((a) => ({ code: a.code, name: a.name })),
      taxCategories: TaxCategoryCode.options,
    },
    ledgerAccounts,
    threshold,
  });
  const infer: EvalInfer = async (sample) => {
    if (!includeAi) return NONE;
    const work = works.get(sample.statementId) as AiWork;
    return aiPrediction(work, await suggester.suggest(work), ledgerAccounts);
  };
  const result: EvalResult = await evaluate(samples, splitDate, infer);

  // 3. 書く
  return deps.uow.run((tx) => {
    const record: EvalRunRecord = {
      id: deps.ids.next(),
      splitDate,
      includeAi,
      sampleCount: result.sampleCount,
      resultJson: JSON.stringify({ fields: result.fields, methods: result.methods }),
      modelsJson: JSON.stringify(suggester.usedModels()),
      createdAt: deps.clock.now(),
    };
    tx.statements.insertEvalRun(record);
    return ok(toEvalRun(record));
  });
}

/** 評価の実行の一覧（新しい順。前回との差は web で出す） */
export function listEvalRuns(deps: Pick<{ uow: StatementUnitOfWork }, "uow">): Result<EvalRun[]> {
  return deps.uow.run((tx) => ok(tx.statements.listEvalRuns().map(toEvalRun)));
}
