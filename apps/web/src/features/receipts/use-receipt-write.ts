import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReceiptDetail } from "@trebuchet/schema";
import { isApiError } from "@/lib/api";
import { receiptKeys } from "./api";

/**
 * 証憑を変える操作（値の訂正・削除・ファイルの差し替え）の共通の後始末。
 * 成功したら詳細の query を応答で置き換え（onUpdated）、一覧・検索を読み直す（onInvalidated はその後）。
 * 他の操作で版が進んでいた（VERSION_CONFLICT）ら、詳細を読み直す
 */
export function useReceiptWrite<Input>(
  entityId: string,
  receiptId: string,
  write: (input: Input) => Promise<ReceiptDetail>,
  options: {
    /** 詳細を置き換えた直後（一覧を読み直す前）に呼ぶ */
    onUpdated?: (updated: ReceiptDetail) => void;
    /** 一覧・検索を読み直したあとに呼ぶ */
    onInvalidated?: () => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: async (updated) => {
      queryClient.setQueryData(receiptKeys.detail(entityId, receiptId), updated);
      options.onUpdated?.(updated);
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
      options.onInvalidated?.();
    },
    onError: async (error) => {
      if (isApiError(error, "VERSION_CONFLICT")) {
        await queryClient.invalidateQueries({ queryKey: receiptKeys.detail(entityId, receiptId) });
      }
    },
  });
}
