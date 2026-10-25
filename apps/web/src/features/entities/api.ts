import { queryOptions } from "@tanstack/react-query";
import type { TaxSettingsPut } from "@trebuchet/schema";
import { api, type QueryItem, unwrap } from "@/lib/api";

// 事業体・消費税の設定の API（001 contracts/http-api.md）

const entitiesApi = api.api.entities;
const entityApi = entitiesApi[":entityId"];

/** クエリのキー。事業体ごとに入れ子にし、`entity` の前方一致で事業体の下をまとめて無効にできる */
export const entityKeys = {
  all: ["entities"] as const,
  entity: (entityId: string) => ["entities", entityId] as const,
  taxSettings: (entityId: string) => ["entities", entityId, "tax-settings"] as const,
  taxCategories: (entityId: string) => ["entities", entityId, "tax-categories"] as const,
};

export const entitiesQuery = () =>
  queryOptions({
    queryKey: entityKeys.all,
    queryFn: async () => (await unwrap(await entitiesApi.$get())).entities,
  });

export const createEntity = async (json: Parameters<typeof entitiesApi.$post>[0]["json"]) =>
  (await unwrap(await entitiesApi.$post({ json }))).entity;

export const patchEntity = async (
  entityId: string,
  json: Parameters<typeof entityApi.$patch>[0]["json"],
) => unwrap(await entityApi.$patch({ param: { entityId }, json }));

export const taxSettingsQuery = (entityId: string) =>
  queryOptions({
    queryKey: entityKeys.taxSettings(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi["tax-settings"].$get({ param: { entityId } }))).taxSettings,
  });

/** 一覧の全体を置き換える */
export const putTaxSettings = async (entityId: string, json: TaxSettingsPut) =>
  (await unwrap(await entityApi["tax-settings"].$put({ param: { entityId }, json }))).taxSettings;

export const taxCategoriesQuery = (entityId: string) =>
  queryOptions({
    queryKey: entityKeys.taxCategories(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi["tax-categories"].$get({ param: { entityId } }))).taxCategories,
  });

export type TaxSetting = QueryItem<typeof taxSettingsQuery>;
export type TaxCategory = QueryItem<typeof taxCategoriesQuery>;
