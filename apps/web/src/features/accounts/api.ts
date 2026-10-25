import { queryOptions } from "@tanstack/react-query";
import type { AccountCreate, AccountPatch, SubAccountCreate } from "@trebuchet/schema";
import { api, type QueryItem, unwrap } from "@/lib/api";

// 勘定科目・補助科目の API（001 contracts/http-api.md）

const accountApi = api.api.entities[":entityId"].accounts;

export const accountKeys = {
  list: (entityId: string) => ["entities", entityId, "accounts"] as const,
  subAccounts: (entityId: string, accountId: string) =>
    ["entities", entityId, "accounts", accountId, "sub-accounts"] as const,
};

export const accountsQuery = (entityId: string) =>
  queryOptions({
    queryKey: accountKeys.list(entityId),
    queryFn: async () => (await unwrap(await accountApi.$get({ param: { entityId } }))).accounts,
  });

export const subAccountsQuery = (entityId: string, accountId: string) =>
  queryOptions({
    queryKey: accountKeys.subAccounts(entityId, accountId),
    queryFn: async () =>
      (
        await unwrap(
          await accountApi[":accountId"]["sub-accounts"].$get({
            param: { entityId, accountId },
          }),
        )
      ).subAccounts,
  });

export const postAccount = async (entityId: string, json: AccountCreate) =>
  (await unwrap(await accountApi.$post({ param: { entityId }, json }))).account;

export const patchAccount = async (entityId: string, accountId: string, json: AccountPatch) =>
  unwrap(await accountApi[":accountId"].$patch({ param: { entityId, accountId }, json }));

export const deleteAccount = async (entityId: string, accountId: string) =>
  unwrap(await accountApi[":accountId"].$delete({ param: { entityId, accountId } }));

export const postSubAccount = async (entityId: string, accountId: string, json: SubAccountCreate) =>
  unwrap(
    await accountApi[":accountId"]["sub-accounts"].$post({ param: { entityId, accountId }, json }),
  );

export type Account = QueryItem<typeof accountsQuery>;
export type SubAccount = QueryItem<typeof subAccountsQuery>;
