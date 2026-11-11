import { z } from "zod";
import { ACCOUNT_CODES } from "./account-codes.ts";
import { DateString, Id } from "./primitives.ts";

// 011-ui-overhaul（data-model §2.1、contracts/http-api.md §1）。ホームの要約。保存しない値

/** 今期の数字の「現金と預金」にする科目のコード（seed の現金 1010・普通預金 1020。R3） */
export const CASH_AND_DEPOSIT_CODES: readonly string[] = [
  ACCOUNT_CODES.cash,
  ACCOUNT_CODES.ordinaryDeposit,
];

/** ホームの「最近の仕訳」の件数 */
export const HOME_RECENT_JOURNAL_COUNT = 5;

/** 項目ごとの成否。1 項目の失敗で応答全体を失敗にしない（FR-009） */
export type Section<T> = { status: "ok"; value: T } | { status: "error"; code: string };

/** `Section` の Zod スキーマ */
export const sectionOf = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), value }),
    z.object({ status: z.literal("error"), code: z.string() }),
  ]);

const Count = z.number().int().nonnegative();
/** 金額（0 と負を含む。利益は赤字がありうる） */
const Money = z.number().int();

/** 今日やること。件数が 0 の項目は画面に出さない */
export const HomeTasks = z.object({
  unprocessedStatements: Count,
  unlinkedReceipts: Count,
  /** 未入金（`unpaid`・`partial`）の請求書 */
  unpaidInvoices: Count,
  /** そのうち期限切れ */
  overdueInvoices: Count,
  blockedRecurring: Count,
  blueReturnWarnings: Count,
});
export type HomeTasks = z.infer<typeof HomeTasks>;

/** 今期の数字。今日を含む会計期間がなければ null（登録の案内を出す） */
export const HomeFigures = z.object({
  fiscalYear: z.number().int(),
  from: DateString,
  to: DateString,
  sales: Money,
  expenses: Money,
  netIncome: Money,
  cashAndDeposits: Money,
  outstanding: Money,
});
export type HomeFigures = z.infer<typeof HomeFigures>;

export const HomeRecentJournal = z.object({
  id: Id,
  number: z.number().int().positive(),
  date: DateString,
  memo: z.string().nullable(),
  amount: Money,
  createdAt: z.string(),
});
export type HomeRecentJournal = z.infer<typeof HomeRecentJournal>;

/** GET /entities/:id/home */
export const HomeSummary = z.object({
  tasks: sectionOf(HomeTasks),
  figures: sectionOf(HomeFigures.nullable()),
  recentJournals: sectionOf(z.array(HomeRecentJournal)),
  /** 取込の回の `createdAt` の最大。なければ null */
  lastStatementImportAt: sectionOf(z.string().nullable()),
});
export type HomeSummary = z.infer<typeof HomeSummary>;
