import type { ReceiptDetail } from "@trebuchet/schema";
import type { JournalFormSource } from "@/features/journals/JournalForm";
import type { Partner } from "@/features/masters/api";

/**
 * 証憑から仕訳を作るときの、仕訳の入力の初期値（FR-010）。取引年月日・金額・取引先を引き継ぐ。
 * 借方と貸方の 2 行に同じ金額を入れ、勘定科目は利用者が選ぶ。取引先は名前が同じ有効な取引先があれば選び、
 * 名前はメモにも入れる。未入力の値は空のまま（日付だけは `fallbackDate`）
 */
export function journalSourceOf(
  receipt: Pick<ReceiptDetail, "transactionDate" | "amount" | "partnerName">,
  partners: readonly Pick<Partner, "id" | "name" | "isActive">[],
  fallbackDate: string,
): JournalFormSource {
  const partner =
    receipt.partnerName === null
      ? undefined
      : partners.find((p) => p.isActive && p.name === receipt.partnerName);
  const line = (side: "debit" | "credit") => ({
    side,
    accountId: "",
    subAccountId: null,
    amount: receipt.amount ?? undefined,
    taxCategory: null,
    partnerId: partner?.id ?? null,
    description: null,
    tagIds: [],
  });
  return {
    date: receipt.transactionDate ?? fallbackDate,
    memo: receipt.partnerName,
    lines: [line("debit"), line("credit")],
  };
}
