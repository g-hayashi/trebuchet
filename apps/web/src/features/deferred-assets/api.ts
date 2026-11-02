import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

// 繰延資産（開業費）の API（009 contracts/http-api.md「開業費」）

const deferredApi = api.api.entities[":entityId"]["deferred-assets"];

/** 開業費のクエリのキー。保存・決定・案の登録のあとは事業体の開業費をまとめて読み直す */
export const deferredAssetKeys = {
  all: (entityId: string) => ["entities", entityId, "deferred-assets"] as const,
  list: (entityId: string, year: number | undefined) =>
    ["entities", entityId, "deferred-assets", year ?? null] as const,
};

const listDeferredAssets = async (entityId: string, year: number | undefined) =>
  (
    await unwrap(
      await deferredApi.$get({
        param: { entityId },
        query: year === undefined ? {} : { year: String(year) },
      }),
    )
  ).deferredAssets;

/** 開業費の1行（API の応答）。year を付けたときは amortization に年分の上限・目安・決定が入る */
export type DeferredAssetRow = Awaited<ReturnType<typeof listDeferredAssets>>[number];

export const deferredAssetsQuery = (entityId: string, year?: number) =>
  queryOptions({
    queryKey: deferredAssetKeys.list(entityId, year),
    queryFn: () => listDeferredAssets(entityId, year),
  });

export const postDeferredAsset = async (
  entityId: string,
  json: Parameters<typeof deferredApi.$post>[0]["json"],
) => unwrap(await deferredApi.$post({ param: { entityId }, json }));

export const putDeferredAsset = async (
  entityId: string,
  deferredAssetId: string,
  json: Parameters<(typeof deferredApi)[":deferredAssetId"]["$put"]>[0]["json"],
) =>
  unwrap(
    await deferredApi[":deferredAssetId"].$put({ param: { entityId, deferredAssetId }, json }),
  );

/** 年分の償却額を決める。0 円は「償却しない」の決定 */
export const putDeferredAmortization = async (
  entityId: string,
  deferredAssetId: string,
  year: number,
  amount: number,
) =>
  unwrap(
    await deferredApi[":deferredAssetId"].amortizations[":year"].$put({
      param: { entityId, deferredAssetId, year: String(year) },
      json: { amount },
    }),
  );
