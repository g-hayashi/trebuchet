import { type AiSuggestion, TaxCategoryCode } from "@trebuchet/schema";
import type { JournalEntryInput } from "../statements/mask.ts";
import { counterAccounts } from "../statements/prompt.ts";
import { domainError, err, ok, type Result } from "../types.ts";
import { createAiSuggester, type InferenceDeps } from "./inference.ts";
import { DEFAULT_STATEMENT_SETTINGS } from "./statements.ts";

// 仕訳の入力の AI の候補（011/R19、FR-060）。006 の経路（`createAiSuggester`）に場面 `journal_entry` を足しただけ。
// ルールは使わず、端末内 → 外部の順。候補は保存しない（読む → AI を呼ぶ（UnitOfWork の外）の 2 段で、書く段はない）

/** `POST /journals/ai-suggestion` の出力。`suggestion` がなければ候補なし（`reason` は使える範囲の理由） */
export type JournalEntrySuggestion = { suggestion: AiSuggestion | null; reason?: string };

/**
 * 摘要・金額・日付から科目・税区分の候補を出す。外部の AI が無効（`externalEnabled` が偽、または
 * `external.available()` が偽）なら、AI を呼ばずに `AI_NOT_CONFIGURED`。
 * AI に渡すのは `buildJournalEntryPayload` の結果だけ（INV-45）。出力は `parseSuggestion` で検証し、
 * 一覧にない科目・税区分は候補なし（INV-46）
 */
export async function suggestJournalEntry(
  deps: InferenceDeps,
  input: JournalEntryInput,
): Promise<Result<JournalEntrySuggestion>> {
  if (!deps.externalEnabled || !(await deps.external.available())) {
    return err(
      domainError("AI_NOT_CONFIGURED", "外部の AI が有効ではありません。設定で有効にしてください"),
    );
  }

  // 1. 読む
  const read = deps.uow.run((tx) => {
    const ledgerAccounts = tx.masters.listAccounts();
    const threshold =
      tx.statements.getStatementSettings()?.externalThreshold ??
      DEFAULT_STATEMENT_SETTINGS.externalThreshold;
    return ok({ ledgerAccounts, threshold });
  });
  if (!read.ok) return read;
  const { ledgerAccounts, threshold } = read.value;

  // 2. AI を呼ぶ（UnitOfWork の外）
  const suggester = createAiSuggester(deps, {
    ledgerAccounts,
    threshold,
    context: {
      accounts: counterAccounts(ledgerAccounts).map((a) => ({ code: a.code, name: a.name })),
      taxCategories: TaxCategoryCode.options,
    },
  });
  const outcome = await suggester.suggest(input);
  const suggestion = outcome?.suggestion;
  if (suggestion == null) {
    const reason = outcome?.failure ?? "";
    return ok(reason === "" ? { suggestion: null } : { suggestion: null, reason });
  }
  const { accountId: _accountId, ...value } = suggestion.value;
  return ok({ suggestion: value });
}
