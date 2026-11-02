import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  ReceiptCreateOptions,
  ReceiptDetail,
  ReceiptQuery,
  ReceiptUpdateInput,
} from "@trebuchet/schema";
import { uploadForm } from "@/features/imports/upload";
import { api, unwrap } from "@/lib/api";

// 証憑の API（010 contracts/http-api.md §2）

const receiptApi = api.api.entities[":entityId"].receipts;

export const receiptKeys = {
  all: (entityId: string) => ["entities", entityId, "receipts"] as const,
  search: (entityId: string, search: ReceiptSearch) =>
    ["entities", entityId, "receipts", "search", search] as const,
  detail: (entityId: string, receiptId: string) =>
    ["entities", entityId, "receipts", "detail", receiptId] as const,
};

/** 証憑の検索条件（ページの指定を除く） */
export type ReceiptSearch = Omit<ReceiptQuery, "cursor" | "limit">;

/** API のクエリ文字列にする。指定のない条件と false は送らない */
function searchParams(search: ReceiptSearch, cursor: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...search, cursor })) {
    if (value === undefined || value === false || value === "") continue;
    params[key] = String(value);
  }
  return params;
}

/** 証憑の検索（FR-008）。受領日時の新しい順で、cursor でページを続ける */
export const receiptSearchQuery = (entityId: string, search: ReceiptSearch) =>
  infiniteQueryOptions({
    queryKey: receiptKeys.search(entityId, search),
    queryFn: async ({ pageParam }) =>
      unwrap(
        await receiptApi.$get({
          param: { entityId },
          query: searchParams(search, pageParam),
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** 証憑の詳細（削除済みも返る） */
export const receiptQuery = (entityId: string, receiptId: string) =>
  queryOptions({
    queryKey: receiptKeys.detail(entityId, receiptId),
    queryFn: async (): Promise<ReceiptDetail> =>
      (await unwrap(await receiptApi[":receiptId"].$get({ param: { entityId, receiptId } })))
        .receipt,
  });

/**
 * 証憑のファイルの URL（表示・取り出し）。`display` は HEIC を JPEG にした表示用、
 * `original` は原本（`download` で保存のダイアログ）
 */
export const receiptFileUrl = (
  entityId: string,
  receiptId: string,
  sha256: string,
  variant: "display" | "original" = "display",
  download = false,
): string =>
  `/api/entities/${encodeURIComponent(entityId)}/receipts/${encodeURIComponent(receiptId)}/files/${sha256}?variant=${variant}${download ? "&download=1" : ""}`;

/** 追加（multipart: `file` と `options` の JSON。007 の取込と同じ送り方）。経路は server が決める */
export const postReceipt = async (
  entityId: string,
  file: File,
  options: ReceiptCreateOptions,
): Promise<{ receipt: ReceiptDetail }> =>
  uploadForm(`/api/entities/${encodeURIComponent(entityId)}/receipts`, {
    file,
    options: JSON.stringify(options),
  });

/** 値の更新（未入力を埋める・メモ。入力済みの値の訂正は理由が要る） */
export const patchReceipt = async (
  entityId: string,
  receiptId: string,
  json: ReceiptUpdateInput,
): Promise<ReceiptDetail> =>
  (await unwrap(await receiptApi[":receiptId"].$patch({ param: { entityId, receiptId }, json })))
    .receipt;
