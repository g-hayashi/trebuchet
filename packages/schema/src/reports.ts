import { z } from "zod";
import { Warning } from "./errors.ts";
import {
  AccountCategory,
  DateString,
  Id,
  ReportSection,
  Side,
  TaxCategoryCode,
} from "./primitives.ts";

// ---- クエリ（GET /entities/:entityId/reports/*） ----

export const ReportFormat = z.enum(["json", "csv"]);
export type ReportFormat = z.infer<typeof ReportFormat>;

export const ReportCompare = z.enum(["previous-year"]);
export type ReportCompare = z.infer<typeof ReportCompare>;

const format = ReportFormat.default("json");

const fromNotAfterTo = <T extends { from: string; to: string }>(v: T) => v.from <= v.to;
const RANGE_ORDER = { message: "開始日は終了日以前にしてください", path: ["to"] };

/** 期間（from〜to, 両端を含む）の帳票のクエリ */
export const ReportRangeFields = z.object({ from: DateString, to: DateString, format });

export const JournalBookQuery = ReportRangeFields.refine(fromNotAfterTo, RANGE_ORDER);
export type JournalBookQuery = z.infer<typeof JournalBookQuery>;

export const TrialBalanceQuery = ReportRangeFields.refine(fromNotAfterTo, RANGE_ORDER);
export type TrialBalanceQuery = z.infer<typeof TrialBalanceQuery>;

export const GeneralLedgerQuery = ReportRangeFields.extend({
  accountId: Id,
  subAccountId: Id.optional(),
}).refine(fromNotAfterTo, RANGE_ORDER);
export type GeneralLedgerQuery = z.infer<typeof GeneralLedgerQuery>;

export const ProfitAndLossQuery = ReportRangeFields.extend({
  compare: ReportCompare.optional(),
}).refine(fromNotAfterTo, RANGE_ORDER);
export type ProfitAndLossQuery = z.infer<typeof ProfitAndLossQuery>;

export const BalanceSheetQuery = z.object({
  asOf: DateString,
  compare: ReportCompare.optional(),
  format,
});
export type BalanceSheetQuery = z.infer<typeof BalanceSheetQuery>;

// ---- レスポンス（各帳票 ＋ warnings） ----

/** 帳票の金額（符号付きの整数。科目の通常の側を正とする） */
const Amount = z.number().int();

/** 帳票に載せる科目の項目 */
export const ReportAccount = z.object({
  accountId: Id,
  code: z.string(),
  name: z.string(),
  category: AccountCategory,
  normalSide: Side,
});
export type ReportAccount = z.infer<typeof ReportAccount>;

/** 金額と、前年比較のときの前年・増減（= 当年 − 前年） */
export const Figure = z.object({
  amount: Amount,
  previous: Amount.optional(),
  change: Amount.optional(),
});
export type Figure = z.infer<typeof Figure>;

export const JournalBookLine = z.object({
  lineNo: z.number().int().positive(),
  side: Side,
  accountId: Id,
  accountName: z.string(),
  subAccountId: Id.nullable(),
  subAccountName: z.string().nullable(),
  partnerId: Id.nullable(),
  partnerName: z.string().nullable(),
  amount: Amount,
  taxCategory: TaxCategoryCode,
  taxAmount: Amount,
  description: z.string().nullable(),
});
export type JournalBookLine = z.infer<typeof JournalBookLine>;

export const JournalBookEntry = z.object({
  journalId: Id,
  journalNo: z.number().int().positive(),
  date: DateString,
  memo: z.string().nullable(),
  lines: z.array(JournalBookLine),
});
export type JournalBookEntry = z.infer<typeof JournalBookEntry>;

const DebitCredit = z.object({ debit: Amount, credit: Amount });

/** 仕訳帳（FR-026）: 日付 → 仕訳番号の順 */
export const JournalBook = z.object({
  kind: z.literal("journal-book"),
  from: DateString,
  to: DateString,
  entries: z.array(JournalBookEntry),
  totals: DebitCredit,
});
export type JournalBook = z.infer<typeof JournalBook>;

export const GeneralLedgerEntry = z.object({
  journalId: Id,
  journalNo: z.number().int().positive(),
  date: DateString,
  lineNo: z.number().int().positive(),
  /** 相手科目。複数なら「諸口」 */
  counterpart: z.string(),
  /** 行の摘要。なければ仕訳のメモ */
  description: z.string().nullable(),
  debit: Amount,
  credit: Amount,
  balance: Amount,
});
export type GeneralLedgerEntry = z.infer<typeof GeneralLedgerEntry>;

/** 総勘定元帳（FR-027）: 前期繰越から日付順の残高の推移 */
export const GeneralLedger = z.object({
  kind: z.literal("general-ledger"),
  from: DateString,
  to: DateString,
  account: ReportAccount,
  subAccount: z.object({ id: Id, name: z.string() }).nullable(),
  broughtForward: Amount,
  entries: z.array(GeneralLedgerEntry),
  totals: DebitCredit,
  closing: Amount,
});
export type GeneralLedger = z.infer<typeof GeneralLedger>;

export const TrialBalanceRow = ReportAccount.extend({
  opening: Amount,
  debit: Amount,
  credit: Amount,
  closing: Amount,
});
export type TrialBalanceRow = z.infer<typeof TrialBalanceRow>;

/** 残高試算表（FR-028） */
export const TrialBalance = z.object({
  kind: z.literal("trial-balance"),
  from: DateString,
  to: DateString,
  rows: z.array(TrialBalanceRow),
  totals: z.object({
    debit: Amount,
    credit: Amount,
    closingDebit: Amount,
    closingCredit: Amount,
  }),
  balanced: z.boolean(),
});
export type TrialBalance = z.infer<typeof TrialBalance>;

export const StatementRow = z.object({
  accountId: Id,
  code: z.string(),
  name: z.string(),
  reportLine: z.number().int().nullable(),
  amount: Amount,
  previous: Amount.optional(),
  change: Amount.optional(),
});
export type StatementRow = z.infer<typeof StatementRow>;

export const StatementSection = z.object({
  section: ReportSection,
  rows: z.array(StatementRow),
  total: Figure,
});
export type StatementSection = z.infer<typeof StatementSection>;

const Range = z.object({ from: DateString, to: DateString });

/** 損益計算書（FR-029, FR-030） */
export const ProfitAndLoss = z.object({
  kind: z.literal("profit-and-loss"),
  from: DateString,
  to: DateString,
  previous: Range.nullable(),
  sections: z.array(StatementSection),
  /** 売上総利益（売上 − 売上原価） */
  grossProfit: Figure,
  /** 差引金額（当期利益） */
  netIncome: Figure,
});
export type ProfitAndLoss = z.infer<typeof ProfitAndLoss>;

/** 貸借対照表（FR-029, FR-030）。当期利益は純資産の部に含める */
export const BalanceSheet = z.object({
  kind: z.literal("balance-sheet"),
  asOf: DateString,
  previousAsOf: DateString.nullable(),
  sections: z.array(StatementSection),
  netIncome: Figure,
  totalAssets: Figure,
  totalLiabilitiesAndEquity: Figure,
  balanced: z.boolean(),
});
export type BalanceSheet = z.infer<typeof BalanceSheet>;

export type Report = JournalBook | GeneralLedger | TrialBalance | ProfitAndLoss | BalanceSheet;

const withWarnings = { warnings: z.array(Warning) };

export const JournalBookResponse = JournalBook.extend(withWarnings);
export const GeneralLedgerResponse = GeneralLedger.extend(withWarnings);
export const TrialBalanceResponse = TrialBalance.extend(withWarnings);
export const ProfitAndLossResponse = ProfitAndLoss.extend(withWarnings);
export const BalanceSheetResponse = BalanceSheet.extend(withWarnings);
