import type { ReceiptDetail, ReceiptReadingView, ReceiptSummary } from "@trebuchet/schema";

// 010 証憑の画面のテストが共有する応答の例（合成の値）

export const RECEIPT_ID = "00000000-0000-4000-8000-0000000000a1";
export const RECEIPT_SHA = "a".repeat(64);

export const receiptSummary = (over: Partial<ReceiptSummary> = {}): ReceiptSummary => ({
  id: RECEIPT_ID,
  receivedAt: "2026-10-20T09:00:00.000Z",
  channel: "local",
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  mediaType: "image/jpeg",
  deleted: false,
  linkState: "none",
  journal: null,
  warnings: [],
  ...over,
});

const currentFile: ReceiptDetail["currentFile"] = {
  sha256: RECEIPT_SHA,
  fileVersion: 1,
  mediaType: "image/jpeg",
  sizeBytes: 2_500_000,
  originalName: "領収書.jpg",
  width: 4032,
  height: 3024,
  fullColor: true,
  addedAt: "2026-10-20T09:00:00.000Z",
  channel: "local",
};

export const receiptDetail = (over: Partial<ReceiptDetail> = {}): ReceiptDetail => ({
  ...receiptSummary(),
  memo: null,
  version: 1,
  currentFile,
  files: [currentFile],
  readings: [],
  deletedAt: null,
  deletedReason: null,
  ...over,
});

/** 外部の AI の読み取りの記録（010 US4）。既定は成功で、候補はすべて「なし」。`readAt` は現在のファイルの追加より後 */
export const receiptReading = (over: Partial<ReceiptReadingView> = {}): ReceiptReadingView => ({
  id: "00000000-0000-4000-8000-0000000000b1",
  readAt: "2026-10-20T09:05:00.000Z",
  model: "model-a",
  status: "succeeded",
  errorCode: null,
  candidates: {
    transactionDate: null,
    amount: null,
    partnerName: null,
    accountCode: null,
    taxCategory: null,
  },
  confidence: 80,
  reason: null,
  ...over,
});
