import type { ReceiptDetail, ReceiptReadingView, TaxCategoryCode } from "@trebuchet/schema";
import type { Account } from "@/features/accounts/api";
import type { TaxCategory } from "@/features/entities/api";
import type { JournalFormSource } from "@/features/journals/JournalForm";
import type { Partner } from "@/features/masters/api";

/** AI の候補の科目・税区分（010 US4）を、仕訳の入力の行にするための形 */
export type ReadingSuggestion = {
  account: Pick<Account, "id" | "name" | "normalSide">;
  taxCategory: Pick<TaxCategory, "code" | "name"> | null;
};

/**
 * 読み取りの候補（科目のコード・税区分）を、事業体の有効な科目と税区分の一覧から引く。
 * 一覧にない科目は「候補なし」（科目がなければ税区分も置く行がないので使わない）
 */
export function suggestionOf(
  reading: ReceiptReadingView | undefined,
  accounts: readonly Account[],
  taxCategories: readonly TaxCategory[],
): ReadingSuggestion | undefined {
  if (reading === undefined || reading.status !== "succeeded") return undefined;
  const code = reading.candidates.accountCode;
  const account = code === null ? undefined : accounts.find((a) => a.isActive && a.code === code);
  if (account === undefined) return undefined;
  const tax = reading.candidates.taxCategory;
  return {
    account,
    taxCategory: tax === null ? null : (taxCategories.find((c) => c.code === tax) ?? null),
  };
}

/**
 * 証憑から仕訳を作るときの、仕訳の入力の初期値（FR-010）。取引年月日・金額・取引先を引き継ぐ。
 * 借方と貸方の 2 行に同じ金額を入れ、勘定科目は利用者が選ぶ。取引先は名前が同じ有効な取引先があれば選び、
 * 名前はメモにも入れる。未入力の値は空のまま（日付だけは `fallbackDate`）。
 * AI の候補（`suggestion`）があれば、その科目の通常の残高の側の行に科目と税区分を入れる（相手の行は選ばない）
 */
export function journalSourceOf(
  receipt: Pick<ReceiptDetail, "transactionDate" | "amount" | "partnerName">,
  partners: readonly Pick<Partner, "id" | "name" | "isActive">[],
  fallbackDate: string,
  suggestion?: ReadingSuggestion | undefined,
): JournalFormSource {
  const partner =
    receipt.partnerName === null
      ? undefined
      : partners.find((p) => p.isActive && p.name === receipt.partnerName);
  const line = (side: "debit" | "credit") => {
    const suggested = suggestion?.account.normalSide === side ? suggestion : undefined;
    return {
      side,
      accountId: suggested?.account.id ?? "",
      subAccountId: null,
      amount: receipt.amount ?? undefined,
      taxCategory: (suggested?.taxCategory?.code ?? null) as TaxCategoryCode | null,
      partnerId: partner?.id ?? null,
      description: null,
      tagIds: [],
    };
  };
  return {
    date: receipt.transactionDate ?? fallbackDate,
    memo: receipt.partnerName,
    lines: [line("debit"), line("credit")],
  };
}
