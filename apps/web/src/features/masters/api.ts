import { queryOptions } from "@tanstack/react-query";
import type { PartnerInput, TagCreate } from "@trebuchet/schema";
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

export const postPartner = async (entityId: string, json: PartnerInput) =>
  unwrap(await entityApi.partners.$post({ param: { entityId }, json }));

export const patchPartner = async (entityId: string, partnerId: string, json: PartnerInput) =>
  unwrap(await entityApi.partners[":partnerId"].$patch({ param: { entityId, partnerId }, json }));

export const postTag = async (entityId: string, json: TagCreate) =>
  unwrap(await entityApi.tags.$post({ param: { entityId }, json }));

export type Partner = QueryItem<typeof partnersQuery>;
export type Tag = QueryItem<typeof tagsQuery>;
