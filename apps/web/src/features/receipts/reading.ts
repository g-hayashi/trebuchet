import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReceiptDetail, ReceiptReadingView } from "@trebuchet/schema";
import { aiSettingsQuery } from "@/features/ai-settings/api";
import { postReceiptReading, receiptKeys } from "./api";

// 外部の AI の読み取り（010 US4）の、画面が共有する部品

/**
 * 今のファイルの版に対する読み取りの記録（`readAt` が版の追加以降のもの）。古い版を読んだ候補は使わない
 */
function readingsOfCurrentFile(receipt: ReceiptDetail): ReceiptReadingView[] {
  return receipt.readings
    .filter((r) => r.readAt >= receipt.currentFile.addedAt)
    .sort((a, b) => (a.readAt < b.readAt ? -1 : a.readAt > b.readAt ? 1 : 0));
}

/**
 * - `ready`: 設定を読み終えたか（初期値にだけ使う画面は、読み終えてからフォームを開く）
 * - `enabled`: 設定「証憑の画像を外部の AI に送る」が有効か（無効なら読み取りの操作も候補も使わない）
 * - `latest`: 今の版の最新の記録（失敗を示すため、状態を問わない）
 * - `usable`: 今の版の最新の成功した記録。入力欄・仕訳の初期値に使う候補の元
 */
export function useReceiptReading(receipt: ReceiptDetail | undefined): {
  ready: boolean;
  enabled: boolean;
  latest: ReceiptReadingView | undefined;
  usable: ReceiptReadingView | undefined;
} {
  const settings = useQuery(aiSettingsQuery());
  const ready = !settings.isPending;
  const enabled =
    settings.data?.externalEnabled === true && settings.data.receiptImagesEnabled === true;
  if (!enabled || receipt === undefined) {
    return { ready, enabled, latest: undefined, usable: undefined };
  }
  const readings = readingsOfCurrentFile(receipt);
  return {
    ready,
    enabled,
    latest: readings.at(-1),
    usable: readings.findLast((r) => r.status === "succeeded"),
  };
}

/**
 * 追加の直後の自動の読み取り（R13）。設定が有効なときだけ readings を呼ぶ。追加の応答は待たず、
 * 失敗も示さない（記録は server が残し、証憑の詳細で読み直せる）。呼んだ後は証憑のクエリを読み直す
 */
export function useAutoReceiptReading(entityId: string): (receiptId: string) => void {
  const queryClient = useQueryClient();
  const settings = useQuery(aiSettingsQuery());
  const enabled =
    settings.data?.externalEnabled === true && settings.data.receiptImagesEnabled === true;
  return (receiptId) => {
    if (!enabled) return;
    void postReceiptReading(entityId, receiptId)
      .then(() => queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) }))
      .catch(() => undefined);
  };
}
