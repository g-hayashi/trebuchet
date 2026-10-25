import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { JournalCorrection, JournalInput, JournalQuery } from "@trebuchet/schema";
import { api, type QueryData, type QueryItem, unwrap } from "@/lib/api";

// 仕訳の API（001 contracts/http-api.md）

const journalApi = api.api.entities[":entityId"].journals;

export const journalKeys = {
  all: (entityId: string) => ["entities", entityId, "journals"] as const,
  search: (entityId: string, search: JournalSearch) =>
    ["entities", entityId, "journals", "search", search] as const,
  detail: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId] as const,
  history: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId, "history"] as const,
};

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
    queryKey: journalKeys.search(entityId, search),
    queryFn: async ({ pageParam }) =>
      unwrap(
        await journalApi.$get({
          param: { entityId },
          query: searchParams(search, pageParam),
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** 仕訳と、訂正元・訂正仕訳への参照 */
export const journalQuery = (entityId: string, journalId: string) =>
  queryOptions({
    queryKey: journalKeys.detail(entityId, journalId),
    queryFn: async () =>
      unwrap(await journalApi[":journalId"].$get({ param: { entityId, journalId } })),
  });

export const journalHistoryQuery = (entityId: string, journalId: string) =>
  queryOptions({
    queryKey: journalKeys.history(entityId, journalId),
    queryFn: async () =>
      (
        await unwrap(
          await journalApi[":journalId"].history.$get({ param: { entityId, journalId } }),
        )
      ).history,
  });

export const postJournal = async (entityId: string, json: JournalInput) =>
  unwrap(await journalApi.$post({ param: { entityId }, json }));

export const putJournal = async (entityId: string, journalId: string, json: JournalCorrection) =>
  unwrap(await journalApi[":journalId"].$put({ param: { entityId, journalId }, json }));

export const postJournalVoid = async (
  entityId: string,
  journalId: string,
  json: { reason: string; version: number },
) => unwrap(await journalApi[":journalId"].void.$post({ param: { entityId, journalId }, json }));

export type JournalDetail = QueryData<typeof journalQuery>;
export type Journal = JournalDetail["journal"];
export type HistoryEntry = QueryItem<typeof journalHistoryQuery>;
