import { queryOptions } from "@tanstack/react-query";
import type { PartnerProfileInput, TagCreate } from "@trebuchet/schema";
import { api, type QueryItem, unwrap } from "@/lib/api";

// 取引先・メモタグの API（001 contracts/http-api.md）

const entityApi = api.api.entities[":entityId"];

export const masterKeys = {
  partners: (entityId: string) => ["entities", entityId, "partners"] as const,
  tags: (entityId: string) => ["entities", entityId, "tags"] as const,
};

export const partnersQuery = (entityId: string) =>
  queryOptions({
    queryKey: masterKeys.partners(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi.partners.$get({ param: { entityId } }))).partners,
  });

export const tagsQuery = (entityId: string) =>
  queryOptions({
    queryKey: masterKeys.tags(entityId),
    queryFn: async () => (await unwrap(await entityApi.tags.$get({ param: { entityId } }))).tags,
  });

/** 取引先と請求の条件を 1 回で追加する（011 R15。`billingTerms` が null なら条件なし） */
export const postPartnerProfile = async (entityId: string, json: PartnerProfileInput) =>
  unwrap(await entityApi.partners.profile.$post({ param: { entityId }, json }));

/** 取引先と請求の条件を 1 回で更新する（`billingTerms` が null なら条件を外す） */
export const putPartnerProfile = async (
  entityId: string,
  partnerId: string,
  json: PartnerProfileInput,
) =>
  unwrap(
    await entityApi.partners[":partnerId"].profile.$put({ param: { entityId, partnerId }, json }),
  );

export const postTag = async (entityId: string, json: TagCreate) =>
  unwrap(await entityApi.tags.$post({ param: { entityId }, json }));

export type Partner = QueryItem<typeof partnersQuery>;
export type Tag = QueryItem<typeof tagsQuery>;
