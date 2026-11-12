import { queryOptions } from "@tanstack/react-query";
import type {
  BalanceSheetQuery,
  GeneralLedgerQuery,
  JournalBookQuery,
  ProfitAndLossQuery,
  TrialBalanceQuery,
} from "@trebuchet/schema";
import { api, entityPath, type QueryData, unwrap } from "@/lib/api";

// 帳票の API（001 contracts/http-api.md）

const reports = api.api.entities[":entityId"].reports;

/** 帳票のキー。仕訳を変更したら前方一致で無効化する */
export const reportKeys = {
  all: (entityId: string) => ["entities", entityId, "reports"] as const,
};
const reportKey = (entityId: string, kind: string, params: object) =>
  [...reportKeys.all(entityId), kind, params] as const;

/** 帳票の条件（CSV の指定を除く）。指定のないキーは持たない（そのまま API のクエリ文字列にする） */
type ReportRange = Omit<TrialBalanceQuery, "format">;
type JournalBookParams = Omit<JournalBookQuery, "format">;
type GeneralLedgerParams = Omit<GeneralLedgerQuery, "format">;
type ProfitAndLossParams = Omit<ProfitAndLossQuery, "format">;
type BalanceSheetParams = Omit<BalanceSheetQuery, "format">;

const param = (entityId: string) => ({ param: { entityId } });

export const journalBookQuery = (entityId: string, params: JournalBookParams) =>
  queryOptions({
    queryKey: reportKey(entityId, "journal-book", params),
    queryFn: async () =>
      unwrap(await reports["journal-book"].$get({ ...param(entityId), query: params })),
  });

export const generalLedgerQuery = (entityId: string, params: GeneralLedgerParams) =>
  queryOptions({
    queryKey: reportKey(entityId, "general-ledger", params),
    queryFn: async () =>
      unwrap(await reports["general-ledger"].$get({ ...param(entityId), query: params })),
  });

export const trialBalanceQuery = (entityId: string, range: ReportRange) =>
  queryOptions({
    queryKey: reportKey(entityId, "trial-balance", range),
    queryFn: async () =>
      unwrap(await reports["trial-balance"].$get({ ...param(entityId), query: range })),
  });

export const profitAndLossQuery = (entityId: string, params: ProfitAndLossParams) =>
  queryOptions({
    queryKey: reportKey(entityId, "profit-and-loss", params),
    queryFn: async () =>
      unwrap(await reports["profit-and-loss"].$get({ ...param(entityId), query: params })),
  });

export const balanceSheetQuery = (entityId: string, params: BalanceSheetParams) =>
  queryOptions({
    queryKey: reportKey(entityId, "balance-sheet", params),
    queryFn: async () =>
      unwrap(await reports["balance-sheet"].$get({ ...param(entityId), query: params })),
  });

export type ReportKind =
  | "journal-book"
  | "general-ledger"
  | "trial-balance"
  | "profit-and-loss"
  | "balance-sheet";

/** 表示中と同じ条件の CSV のダウンロードの URL（001/FR-032）。params のキーの順にクエリ文字列にする */
export function reportCsvUrl(
  entityId: string,
  kind: ReportKind,
  params: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  query.set("format", "csv");
  return `${entityPath(entityId)}/reports/${kind}?${query}`;
}

export type JournalBook = QueryData<typeof journalBookQuery>;
export type GeneralLedger = QueryData<typeof generalLedgerQuery>;
export type TrialBalance = QueryData<typeof trialBalanceQuery>;
export type ProfitAndLoss = QueryData<typeof profitAndLossQuery>;
export type BalanceSheet = QueryData<typeof balanceSheetQuery>;
