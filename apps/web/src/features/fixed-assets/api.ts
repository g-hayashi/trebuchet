import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

// 固定資産台帳の API（003 contracts/http-api.md「固定資産台帳」）

const assetsApi = api.api.entities[":entityId"]["fixed-assets"];

/** 台帳のクエリのキー。登録・更新・除却のあとは事業体の台帳をまとめて読み直す */
export const fixedAssetKeys = {
  all: (entityId: string) => ["entities", entityId, "fixed-assets"] as const,
  list: (entityId: string, year: number | undefined) =>
    ["entities", entityId, "fixed-assets", year ?? null] as const,
};

const listFixedAssets = async (entityId: string, year: number | undefined) =>
  (
    await unwrap(
      await assetsApi.$get({
        param: { entityId },
        query: year === undefined ? {} : { year: String(year) },
      }),
    )
  ).assets;

/** 台帳の1行（API の応答） */
export type FixedAssetRow = Awaited<ReturnType<typeof listFixedAssets>>[number];

/** 台帳。year を付けると各資産にその年の償却の計算（depreciation）が付く */
export const fixedAssetsQuery = (entityId: string, year?: number) =>
  queryOptions({
    queryKey: fixedAssetKeys.list(entityId, year),
    queryFn: () => listFixedAssets(entityId, year),
  });

export const postFixedAsset = async (
  entityId: string,
  json: Parameters<typeof assetsApi.$post>[0]["json"],
) => unwrap(await assetsApi.$post({ param: { entityId }, json }));

export const putFixedAsset = async (
  entityId: string,
  assetId: string,
  json: Parameters<(typeof assetsApi)[":assetId"]["$put"]>[0]["json"],
) => unwrap(await assetsApi[":assetId"].$put({ param: { entityId, assetId }, json }));

export const disposeFixedAsset = async (
  entityId: string,
  assetId: string,
  json: Parameters<(typeof assetsApi)[":assetId"]["dispose"]["$post"]>[0]["json"],
) => unwrap(await assetsApi[":assetId"].dispose.$post({ param: { entityId, assetId }, json }));
