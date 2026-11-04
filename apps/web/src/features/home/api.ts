import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";

// ホームの要約の API（011 contracts/http-api.md §1）。件数・金額の規則は server（domain）にあり、画面は表示するだけ

const entityApi = api.api.entities[":entityId"];

/** クエリのキー。仕訳が変わる操作の後は `invalidateLedger` が `all` を読み直す */
export const homeKeys = {
  all: (entityId: string) => ["entities", entityId, "home"] as const,
};

/** ホームの要約。項目ごとに `{ status: "ok", value }` か `{ status: "error", code }`（FR-009） */
export const homeQuery = (entityId: string) =>
  queryOptions({
    queryKey: homeKeys.all(entityId),
    queryFn: async () => unwrap(await entityApi.home.$get({ param: { entityId } })),
  });
