import { queryOptions } from "@tanstack/react-query";
import type { OpeningBalancesPut } from "@trebuchet/schema";
import { api, type QueryData, type QueryItem, unwrap } from "@/lib/api";

// 会計期間・期首残高の API（001 contracts/http-api.md）

const periodApi = api.api.entities[":entityId"]["fiscal-periods"];

/** クエリのキー。`list` の前方一致で、一覧・履歴・期首残高をまとめて読み直せる */
export const periodKeys = {
  list: (entityId: string) => ["entities", entityId, "fiscal-periods"] as const,
  history: (entityId: string) => ["entities", entityId, "fiscal-periods", "history"] as const,
  openingBalances: (entityId: string, year: string) =>
    ["entities", entityId, "fiscal-periods", year, "opening-balances"] as const,
};

export const fiscalPeriodsQuery = (entityId: string) =>
  queryOptions({
    queryKey: periodKeys.list(entityId),
    queryFn: async () =>
      (await unwrap(await periodApi.$get({ param: { entityId } }))).fiscalPeriods,
  });

/** 締めと解除の履歴（FR-025, 記録の順） */
export const fiscalPeriodHistoryQuery = (entityId: string) =>
  queryOptions({
    queryKey: periodKeys.history(entityId),
    queryFn: async () =>
      (await unwrap(await periodApi.history.$get({ param: { entityId } }))).history,
  });

export const openingBalancesQuery = (entityId: string, year: string) =>
  queryOptions({
    queryKey: periodKeys.openingBalances(entityId, year),
    queryFn: async () =>
      unwrap(await periodApi[":year"]["opening-balances"].$get({ param: { entityId, year } })),
  });

export const createNextPeriod = async (entityId: string) =>
  (await unwrap(await periodApi.$post({ param: { entityId } }))).fiscalPeriod;

export const closePeriod = async (entityId: string, year: number) =>
  (await unwrap(await periodApi[":year"].close.$post({ param: { entityId, year: String(year) } })))
    .fiscalPeriod;

export const reopenPeriod = async (entityId: string, year: number, reason: string) =>
  (
    await unwrap(
      await periodApi[":year"].reopen.$post({
        param: { entityId, year: String(year) },
        json: { reason },
      }),
    )
  ).fiscalPeriod;

export const putOpeningBalances = async (
  entityId: string,
  year: string,
  json: OpeningBalancesPut,
) => unwrap(await periodApi[":year"]["opening-balances"].$put({ param: { entityId, year }, json }));

export type FiscalPeriod = QueryItem<typeof fiscalPeriodsQuery>;
export type OpeningBalancesData = QueryData<typeof openingBalancesQuery>;
