import { queryOptions } from "@tanstack/react-query";
import type {
  AcknowledgeInput,
  RecurringDetailResponse,
  RecurringInput,
  RecurringUpdate,
} from "@trebuchet/schema";
import { api, isApiError, unwrap } from "@/lib/api";

// 定期仕訳の API（005 contracts/http-api.md §5）

const entityApi = api.api.entities[":entityId"];
const recurringApi = entityApi["recurring-journals"];

/** クエリのキー。保存・停止・再開・確認のあとは `all` を前方一致で無効にする（知らせの状態も含む） */
export const recurringKeys = {
  all: (entityId: string) => ["entities", entityId, "recurring"] as const,
  list: (entityId: string) => ["entities", entityId, "recurring", "list"] as const,
  detail: (entityId: string, id: string) =>
    ["entities", entityId, "recurring", "detail", id] as const,
  status: (entityId: string) => ["entities", entityId, "recurring", "status"] as const,
};

/** 定義の一覧（005/§5.1） */
export const recurringListQuery = (entityId: string) =>
  queryOptions({
    queryKey: recurringKeys.list(entityId),
    queryFn: async () => (await unwrap(await recurringApi.$get({ param: { entityId } }))).recurring,
  });

/** 定義・登録の記録・登録できない回（005/§5.3） */
export const recurringDetailQuery = (entityId: string, id: string) =>
  queryOptions({
    queryKey: recurringKeys.detail(entityId, id),
    queryFn: async (): Promise<RecurringDetailResponse> =>
      unwrap(await recurringApi[":id"].$get({ param: { entityId, id } })),
  });

/** 未確認の自動登録と登録できない回（005/§5.8）。事業体の画面の上部の知らせが読む */
export const recurringStatusQuery = (entityId: string) =>
  queryOptions({
    queryKey: recurringKeys.status(entityId),
    queryFn: async () => unwrap(await recurringApi.status.$get({ param: { entityId } })),
  });

/** 作成（005/§5.2）。201 `{ recurring, posted }` */
export const postRecurring = async (entityId: string, json: RecurringInput) =>
  unwrap(await recurringApi.$post({ param: { entityId }, json }));

/** 更新（005/§5.4） */
export const putRecurring = async (entityId: string, id: string, json: RecurringUpdate) =>
  unwrap(await recurringApi[":id"].$put({ param: { entityId, id }, json }));

export const postPause = async (entityId: string, id: string, version: number) =>
  unwrap(await recurringApi[":id"].pause.$post({ param: { entityId, id }, json: { version } }));

/** 再開（005/§5.6）。`fromMonth` の既定は server が今日の月にする */
export const postResume = async (
  entityId: string,
  id: string,
  json: { version: number; fromMonth?: string; confirm?: boolean },
) => unwrap(await recurringApi[":id"].resume.$post({ param: { entityId, id }, json }));

/** この回は登録しない（005/§5.7） */
export const postSkipRun = async (entityId: string, id: string, month: string, reason: string) =>
  unwrap(
    await recurringApi[":id"].runs[":month"].skip.$post({
      param: { entityId, id, month },
      json: { reason },
    }),
  );

/** 確認した（005/§5.9。204） */
export const postAcknowledge = async (entityId: string, runIds: AcknowledgeInput["runIds"]) => {
  await unwrap(await recurringApi.acknowledge.$post({ param: { entityId }, json: { runIds } }));
};

/** `RECURRING_CONFIRM_REQUIRED`（409）の `details`。確認が要る件数と月。違う形のときは undefined */
export function confirmDetailsOf(error: unknown): { count: number; months: string[] } | undefined {
  if (!isApiError(error, "RECURRING_CONFIRM_REQUIRED")) return undefined;
  const { count, months } = error.details ?? {};
  const list = Array.isArray(months)
    ? months.filter((m): m is string => typeof m === "string")
    : [];
  return { count: typeof count === "number" ? count : list.length, months: list };
}
