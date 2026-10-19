import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  BalanceSheetQuery,
  GeneralLedgerQuery,
  JournalQuery,
  ProfitAndLossQuery,
  TrialBalanceQuery,
} from "@trebuchet/schema";
import { api, unwrap } from "./api";

/** クエリのキー。変更後の invalidateQueries で前方一致を使えるよう、事業体ごとに入れ子にする */
export const queryKeys = {
  entities: ["entities"] as const,
  entity: (entityId: string) => ["entities", entityId] as const,
  accounts: (entityId: string) => ["entities", entityId, "accounts"] as const,
  subAccounts: (entityId: string, accountId: string) =>
    ["entities", entityId, "accounts", accountId, "sub-accounts"] as const,
  partners: (entityId: string) => ["entities", entityId, "partners"] as const,
  tags: (entityId: string) => ["entities", entityId, "tags"] as const,
  taxSettings: (entityId: string) => ["entities", entityId, "tax-settings"] as const,
  taxCategories: (entityId: string) => ["entities", entityId, "tax-categories"] as const,
  fiscalPeriods: (entityId: string) => ["entities", entityId, "fiscal-periods"] as const,
  fiscalPeriodHistory: (entityId: string) =>
    ["entities", entityId, "fiscal-periods", "history"] as const,
  openingBalances: (entityId: string, year: string) =>
    ["entities", entityId, "fiscal-periods", year, "opening-balances"] as const,
  journals: (entityId: string) => ["entities", entityId, "journals"] as const,
  journalSearch: (entityId: string, search: JournalSearch) =>
    ["entities", entityId, "journals", "search", search] as const,
  journal: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId] as const,
  journalHistory: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId, "history"] as const,
  /** 帳票（US4）。仕訳を変更したら前方一致で無効化する */
  reports: (entityId: string) => ["entities", entityId, "reports"] as const,
};

const entity = api.api.entities[":entityId"];

type QueryFactory = (...args: never[]) => { queryFn?: unknown };
type DataOf<Q extends QueryFactory> = Awaited<
  ReturnType<Extract<ReturnType<Q>["queryFn"], (...args: never[]) => unknown>>
>;
/** クエリの結果の型（配列ならその要素の型） */
type Item<Q extends QueryFactory> = DataOf<Q> extends readonly (infer I)[] ? I : DataOf<Q>;
const param = (entityId: string) => ({ param: { entityId } });

export const entitiesQuery = () =>
  queryOptions({
    queryKey: queryKeys.entities,
    queryFn: async () => (await unwrap(await api.api.entities.$get())).entities,
  });

export const accountsQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.accounts(entityId),
    queryFn: async () => (await unwrap(await entity.accounts.$get(param(entityId)))).accounts,
  });

export const subAccountsQuery = (entityId: string, accountId: string) =>
  queryOptions({
    queryKey: queryKeys.subAccounts(entityId, accountId),
    queryFn: async () =>
      (
        await unwrap(
          await entity.accounts[":accountId"]["sub-accounts"].$get({
            param: { entityId, accountId },
          }),
        )
      ).subAccounts,
  });

export const partnersQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.partners(entityId),
    queryFn: async () => (await unwrap(await entity.partners.$get(param(entityId)))).partners,
  });

export const tagsQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.tags(entityId),
    queryFn: async () => (await unwrap(await entity.tags.$get(param(entityId)))).tags,
  });

export const taxSettingsQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.taxSettings(entityId),
    queryFn: async () =>
      (await unwrap(await entity["tax-settings"].$get(param(entityId)))).taxSettings,
  });

export const taxCategoriesQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.taxCategories(entityId),
    queryFn: async () =>
      (await unwrap(await entity["tax-categories"].$get(param(entityId)))).taxCategories,
  });

export const fiscalPeriodsQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.fiscalPeriods(entityId),
    queryFn: async () =>
      (await unwrap(await entity["fiscal-periods"].$get(param(entityId)))).fiscalPeriods,
  });

/** 締めと解除の履歴（FR-025, 記録の順） */
export const fiscalPeriodHistoryQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.fiscalPeriodHistory(entityId),
    queryFn: async () =>
      (await unwrap(await entity["fiscal-periods"].history.$get(param(entityId)))).history,
  });

export const openingBalancesQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: queryKeys.openingBalances(entityId, year),
    queryFn: async () =>
      unwrap(
        await entity["fiscal-periods"][":year"]["opening-balances"].$get({
          param: { entityId, year },
        }),
      ),
  });

/** 仕訳の検索条件（ページの指定を除く） */
export type JournalSearch = Omit<JournalQuery, "cursor" | "limit">;

/** API のクエリ文字列にする。指定のない条件と includeVoided=false は送らない */
function searchParams(search: JournalSearch, cursor: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...search, cursor })) {
    if (value === undefined || value === false || value === "") continue;
    params[key] = String(value);
  }
  return params;
}

/** 仕訳の検索（FR-023）。日付の降順、同じ日付は仕訳番号の降順で、cursor でページを続ける */
export const journalSearchQuery = (entityId: string, search: JournalSearch) =>
  infiniteQueryOptions({
    queryKey: queryKeys.journalSearch(entityId, search),
    queryFn: async ({ pageParam }) =>
      unwrap(
        await entity.journals.$get({
          ...param(entityId),
          query: searchParams(search, pageParam),
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** 仕訳と、訂正元・訂正仕訳への参照 */
export const journalQuery = (entityId: string, journalId: string) =>
  queryOptions({
    queryKey: queryKeys.journal(entityId, journalId),
    queryFn: async () =>
      unwrap(await entity.journals[":journalId"].$get({ param: { entityId, journalId } })),
  });

export const journalHistoryQuery = (entityId: string, journalId: string) =>
  queryOptions({
    queryKey: queryKeys.journalHistory(entityId, journalId),
    queryFn: async () =>
      (
        await unwrap(
          await entity.journals[":journalId"].history.$get({ param: { entityId, journalId } }),
        )
      ).history,
  });

/** 帳票の条件（CSV の指定を除く）。指定のないキーは持たない（そのまま API のクエリ文字列にする） */
export type ReportRange = Omit<TrialBalanceQuery, "format">;
export type GeneralLedgerParams = Omit<GeneralLedgerQuery, "format">;
export type ProfitAndLossParams = Omit<ProfitAndLossQuery, "format">;
export type BalanceSheetParams = Omit<BalanceSheetQuery, "format">;

const reports = entity.reports;
const reportKey = (entityId: string, kind: string, params: object) =>
  [...queryKeys.reports(entityId), kind, params] as const;

export const journalBookQuery = (entityId: string, range: ReportRange) =>
  queryOptions({
    queryKey: reportKey(entityId, "journal-book", range),
    queryFn: async () =>
      unwrap(await reports["journal-book"].$get({ ...param(entityId), query: range })),
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

export type Entity = Item<typeof entitiesQuery>;
export type Account = Item<typeof accountsQuery>;
export type SubAccount = Item<typeof subAccountsQuery>;
export type Partner = Item<typeof partnersQuery>;
export type Tag = Item<typeof tagsQuery>;
export type TaxSetting = Item<typeof taxSettingsQuery>;
export type TaxCategory = Item<typeof taxCategoriesQuery>;
export type FiscalPeriod = Item<typeof fiscalPeriodsQuery>;
export type FiscalPeriodHistoryEntry = Item<typeof fiscalPeriodHistoryQuery>;
export type OpeningBalancesData = Item<typeof openingBalancesQuery>;
export type JournalDetail = DataOf<typeof journalQuery>;
export type Journal = JournalDetail["journal"];
export type JournalRef = JournalDetail["correctingJournals"][number];
export type HistoryEntry = Item<typeof journalHistoryQuery>;
export type JournalBook = DataOf<typeof journalBookQuery>;
export type GeneralLedger = DataOf<typeof generalLedgerQuery>;
export type TrialBalance = DataOf<typeof trialBalanceQuery>;
export type ProfitAndLoss = DataOf<typeof profitAndLossQuery>;
export type BalanceSheet = DataOf<typeof balanceSheetQuery>;
