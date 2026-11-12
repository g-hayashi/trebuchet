import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  JournalCorrection,
  JournalDraft,
  JournalInput,
  JournalQuery,
  JournalSuggestionQuery,
} from "@trebuchet/schema";
import { api, type QueryData, type QueryItem, unwrap } from "@/lib/api";

// 仕訳の API（001 contracts/http-api.md）

const journalApi = api.api.entities[":entityId"].journals;
const draftApi = api.api.entities[":entityId"]["journal-draft"];
// 同じ事業体の下書きの書込は、画面を開き直した場合も順序を保つ。
const draftWrites = new Map<string, Promise<unknown>>();
function serializeDraftWrite<T>(entityId: string, action: () => Promise<T>): Promise<T> {
  const operation = (draftWrites.get(entityId) ?? Promise.resolve()).catch(() => {}).then(action);
  draftWrites.set(entityId, operation);
  const clear = () => {
    if (draftWrites.get(entityId) === operation) draftWrites.delete(entityId);
  };
  void operation.then(clear, clear);
  return operation;
}

export const journalKeys = {
  all: (entityId: string) => ["entities", entityId, "journals"] as const,
  search: (entityId: string, search: JournalSearch) =>
    ["entities", entityId, "journals", "search", search] as const,
  detail: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId] as const,
  history: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId, "history"] as const,
  draft: (entityId: string) => ["entities", entityId, "journal-draft"] as const,
  suggestions: (entityId: string, query: JournalSuggestionQuery) =>
    ["entities", entityId, "journals", "suggestions", query] as const,
};

export const journalDraftQuery = (entityId: string) =>
  queryOptions({
    queryKey: journalKeys.draft(entityId),
    queryFn: async () => unwrap(await draftApi.$get({ param: { entityId } })),
    staleTime: 0,
  });
export const putJournalDraft = async (entityId: string, json: JournalDraft) =>
  serializeDraftWrite(entityId, async () =>
    unwrap(await draftApi.$put({ param: { entityId }, json })),
  );
export const deleteJournalDraft = async (entityId: string) =>
  serializeDraftWrite(entityId, async () =>
    unwrap(await draftApi.$delete({ param: { entityId } })),
  );
export const journalSuggestionsQuery = (entityId: string, query: JournalSuggestionQuery) =>
  queryOptions({
    queryKey: journalKeys.suggestions(entityId, query),
    queryFn: async () =>
      (await unwrap(await journalApi.suggestions.$get({ param: { entityId }, query }))).suggestions,
  });

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

/** 仕訳の検索（001/FR-023）。日付の降順、同じ日付は仕訳番号の降順で、cursor でページを続ける */
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

/** 期間の仕訳の件数（一覧の `summary.count`）。会計期間のカードが使う。取消済みは数えない */
export const journalCountQuery = (entityId: string, dateFrom: string, dateTo: string) =>
  queryOptions({
    queryKey: [...journalKeys.all(entityId), "count", dateFrom, dateTo] as const,
    queryFn: async () =>
      (
        await unwrap(
          await journalApi.$get({
            param: { entityId },
            query: { dateFrom, dateTo, limit: "1" },
          }),
        )
      ).summary.count,
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
