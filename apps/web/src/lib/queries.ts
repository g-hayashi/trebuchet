import { queryOptions } from "@tanstack/react-query";
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
  fiscalPeriods: (entityId: string) => ["entities", entityId, "fiscal-periods"] as const,
  openingBalances: (entityId: string, year: string) =>
    ["entities", entityId, "fiscal-periods", year, "opening-balances"] as const,
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

export const fiscalPeriodsQuery = (entityId: string) =>
  queryOptions({
    queryKey: queryKeys.fiscalPeriods(entityId),
    queryFn: async () =>
      (await unwrap(await entity["fiscal-periods"].$get(param(entityId)))).fiscalPeriods,
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

export type Entity = Item<typeof entitiesQuery>;
export type Account = Item<typeof accountsQuery>;
export type SubAccount = Item<typeof subAccountsQuery>;
export type Partner = Item<typeof partnersQuery>;
export type Tag = Item<typeof tagsQuery>;
export type TaxSetting = Item<typeof taxSettingsQuery>;
export type FiscalPeriod = Item<typeof fiscalPeriodsQuery>;
export type OpeningBalancesData = Item<typeof openingBalancesQuery>;
