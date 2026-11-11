import { ACCOUNT_CODES, type InvoicePriceMode, type TaxCategoryCode } from "@trebuchet/schema";
import {
  type Account,
  err,
  type Journal,
  type JournalDraft,
  type LineDraft,
  notFoundError,
  ok,
  type Result,
} from "../types.ts";
import { calculateInvoiceAmounts } from "./amounts.ts";

/**
 * 請求・入金の仕訳が使う科目のコード（005 R10）。科目の ID の設定は持たず、コードで引く。
 * 見つからなければ `ACCOUNT_NOT_FOUND`、使用停止なら 001 の検証が `ACCOUNT_INACTIVE` を返す
 */
export const INVOICING_ACCOUNT_CODES = {
  /** 売掛金 */
  receivable: ACCOUNT_CODES.receivable,
  /** 売上高 */
  sales: ACCOUNT_CODES.sales,
  /** 支払手数料 */
  paymentFee: ACCOUNT_CODES.paymentFee,
  /** 事業主貸（013。源泉徴収された所得税は事業主個人の税なので入金の仕訳で借方に計上する） */
  ownerDrawing: ACCOUNT_CODES.ownerDrawing,
} as const;

export function findAccountByCode(
  accounts: readonly Pick<Account, "id" | "code">[],
  code: string,
): Result<string> {
  const found = accounts.find((a) => a.code === code);
  if (found === undefined) {
    return err(notFoundError("ACCOUNT_NOT_FOUND", `勘定科目（コード ${code}）`, { code }));
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

export type PaymentJournalSource = {
  invoiceNo: string;
  partnerId: string;
  receivedOn: string;
  /** 入金額 */
  amount: number;
  /** 支払手数料として扱った差額（0 ならなし） */
  feeAmount: number;
  /** 源泉徴収された税額（013。省略・0 ならなし） */
  withholdingAmount?: number | undefined;
  depositAccountId: string;
  depositSubAccountId?: string | null | undefined;
};

/**
 * 入金の消し込みの仕訳の案（R10・R14）。借方 入金先（補助科目つき）に入金額、手数料 > 0 なら借方 支払手数料、
 * 源泉徴収税額 > 0 なら借方 事業主貸（013 R6）、貸方 売掛金に充当額（入金額 + 手数料 + 源泉徴収税額）。
 * 全行に取引先、摘要は `入金 <番号>`、日付は入金日
 */
export function paymentJournalDraft(
  payment: PaymentJournalSource,
  accounts: readonly Pick<Account, "id" | "code">[],
): Result<JournalDraft> {
  const receivable = findAccountByCode(accounts, INVOICING_ACCOUNT_CODES.receivable);
  if (!receivable.ok) return receivable;
  const lines: LineDraft[] = [
    {
      side: "debit",
      accountId: payment.depositAccountId,
      ...(payment.depositSubAccountId == null ? {} : { subAccountId: payment.depositSubAccountId }),
      amount: payment.amount,
      partnerId: payment.partnerId,
    },
  ];
  if (payment.feeAmount > 0) {
    const fee = findAccountByCode(accounts, INVOICING_ACCOUNT_CODES.paymentFee);
    if (!fee.ok) return fee;
    lines.push({
      side: "debit",
      accountId: fee.value,
      amount: payment.feeAmount,
      partnerId: payment.partnerId,
    });
  }
  const withholding = payment.withholdingAmount ?? 0;
  if (withholding > 0) {
    const owner = findAccountByCode(accounts, INVOICING_ACCOUNT_CODES.ownerDrawing);
    if (!owner.ok) return owner;
    lines.push({
      side: "debit",
      accountId: owner.value,
      amount: withholding,
      partnerId: payment.partnerId,
    });
  }
  lines.push({
    side: "credit",
    accountId: receivable.value,
    amount: payment.amount + payment.feeAmount + withholding,
    partnerId: payment.partnerId,
  });
  return ok({ date: payment.receivedOn, memo: `入金 ${payment.invoiceNo}`, lines });
}

export type InvoiceJournalSource = {
  invoiceNo: string;
  partnerId: string;
  /** 売上の計上日 */
  salesDate: string;
  priceMode?: InvoicePriceMode | undefined;
  items: readonly {
    amount: number;
    taxCategory: TaxCategoryCode;
    taxRate?: number | null | undefined;
  }[];
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
  const byRate = new Map<number | null, Map<TaxCategoryCode, number>>();
  for (const item of invoice.items) {
    const rate = item.taxRate ?? null;
    const categories = byRate.get(rate) ?? new Map<TaxCategoryCode, number>();
    categories.set(item.taxCategory, (categories.get(item.taxCategory) ?? 0) + item.amount);
    byRate.set(rate, categories);
  }
  let total = 0;
  for (const [taxRate, categories] of byRate) {
    const subtotal = [...categories.values()].reduce((sum, amount) => sum + amount, 0);
    const inclusive = calculateInvoiceAmounts(
      [{ amount: subtotal, taxRate }],
      invoice.priceMode ?? "inclusive",
    ).total;
    const tax = inclusive - subtotal;
    // 税率のまとまりで税込化してから税区分に配る。端数も含めて合計を保存する。
    let cumulative = 0;
    let allocated = 0;
    for (const [taxCategory, amount] of categories) {
      cumulative += amount;
      const next = Number((BigInt(tax) * BigInt(cumulative)) / BigInt(subtotal));
      byCategory.set(taxCategory, (byCategory.get(taxCategory) ?? 0) + amount + next - allocated);
      allocated = next;
    }
    total += inclusive;
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
