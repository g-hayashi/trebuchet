import type { TaxCategoryCode } from "@trebuchet/schema";
import {
  type Account,
  domainError,
  err,
  type Journal,
  type JournalDraft,
  type LineDraft,
  ok,
  type Result,
} from "../types.ts";

/**
 * 請求・入金の仕訳が使う科目のコード（005 R10）。科目の ID の設定は持たず、コードで引く。
 * 見つからなければ `ACCOUNT_NOT_FOUND`、使用停止なら 001 の検証が `ACCOUNT_INACTIVE` を返す
 */
export const INVOICING_ACCOUNT_CODES = {
  /** 売掛金 */
  receivable: "1030",
  /** 売上高 */
  sales: "4010",
  /** 支払手数料 */
  paymentFee: "5250",
} as const;

export function findAccountByCode(
  accounts: readonly Pick<Account, "id" | "code">[],
  code: string,
): Result<string> {
  const found = accounts.find((a) => a.code === code);
  if (found === undefined) {
    return err(
      domainError("ACCOUNT_NOT_FOUND", `勘定科目（コード ${code}）が見つかりません`, { code }),
    );
  }
  return ok(found.id);
}

/**
 * 逆仕訳（訂正仕訳）の案（R12）。締め済みの年度の請求・入金の仕訳を取り消すときに、今日付で起票する。
 * 貸借を逆にし、税区分・取引先・補助科目・摘要・タグは元の行の値。訂正元は元の仕訳
 */
export function reversalDraft(journal: Journal, today: string): JournalDraft {
  return {
    date: today,
    memo: journal.memo === null ? `仕訳 No.${journal.journalNo} の取消` : `取消: ${journal.memo}`,
    correctsJournalId: journal.id,
    lines: journal.lines.map((l) => ({
      side: l.side === "debit" ? "credit" : "debit",
      accountId: l.accountId,
      ...(l.subAccountId === null ? {} : { subAccountId: l.subAccountId }),
      amount: l.amount,
      taxCategory: l.taxCategory,
      ...(l.partnerId === null ? {} : { partnerId: l.partnerId }),
      ...(l.description === null ? {} : { description: l.description }),
      tagIds: [...l.tagIds],
    })),
  };
}

export type InvoiceJournalSource = {
  invoiceNo: string;
  partnerId: string;
  /** 売上の計上日 */
  salesDate: string;
  items: readonly { amount: number; taxCategory: TaxCategoryCode }[];
};

/**
 * 発行の売上の仕訳の案（R10）。借方 売掛金に合計 1 行、貸方 売上高を税区分ごとに 1 行。
 * 全行に取引先、摘要は `請求書 <番号>`。税額は 001 の `validateJournal` が求める（INV-10）
 */
export function invoiceJournalDraft(
  invoice: InvoiceJournalSource,
  accounts: readonly Pick<Account, "id" | "code">[],
): Result<JournalDraft> {
  const receivable = findAccountByCode(accounts, INVOICING_ACCOUNT_CODES.receivable);
  if (!receivable.ok) return receivable;
  const sales = findAccountByCode(accounts, INVOICING_ACCOUNT_CODES.sales);
  if (!sales.ok) return sales;

  const byCategory = new Map<TaxCategoryCode, number>();
  let total = 0;
  for (const item of invoice.items) {
    byCategory.set(item.taxCategory, (byCategory.get(item.taxCategory) ?? 0) + item.amount);
    total += item.amount;
  }
  const lines: LineDraft[] = [
    { side: "debit", accountId: receivable.value, amount: total, partnerId: invoice.partnerId },
  ];
  for (const [taxCategory, amount] of byCategory) {
    lines.push({
      side: "credit",
      accountId: sales.value,
      amount,
      taxCategory,
      partnerId: invoice.partnerId,
    });
  }
  return ok({ date: invoice.salesDate, memo: `請求書 ${invoice.invoiceNo}`, lines });
}
