import { ReceiptQuery, type ReceiptQueryInput } from "@trebuchet/schema";
import { normalizeReceiptText } from "../src/receipts/search.ts";
import type { ReceiptFileRow, ReceiptLinkRow, ReceiptRow } from "../src/types.ts";
import { NOW } from "./test-dates.ts";

/** 64 文字の 16 進（合成）。`n` ごとに違う値 */
export const fakeSha = (n: number): string => n.toString(16).padStart(64, "0");

/**
 * 証憑の行（010 のテストが共通で使う）。`partnerName` を渡せば `partnerKey` は
 * `normalizeReceiptText` で決める（明示すればそれを使う）。名前・金額はすべて合成
 */
export function makeReceiptRow(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  const partnerName = overrides.partnerName === undefined ? null : overrides.partnerName;
  const base: ReceiptRow = {
    id: "receipt-1",
    receivedAt: NOW,
    channel: "local",
    category: "electronic",
    currentSha256: fakeSha(1),
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName,
    partnerKey: partnerName === null ? null : normalizeReceiptText(partnerName),
    memo: null,
    deletedAt: null,
    deletedReason: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...base, ...overrides };
}

export function makeReceiptFileRow(overrides: Partial<ReceiptFileRow> = {}): ReceiptFileRow {
  return {
    sha256: fakeSha(1),
    receiptId: "receipt-1",
    fileVersion: 1,
    mediaType: "image/jpeg",
    sizeBytes: 1000,
    originalName: "sample.jpg",
    width: 64,
    height: 48,
    fullColor: true,
    addedAt: NOW,
    channel: "local",
    ...overrides,
  };
}

export function makeReceiptLinkRow(overrides: Partial<ReceiptLinkRow> = {}): ReceiptLinkRow {
  return {
    id: "link-1",
    receiptId: "receipt-1",
    journalId: "journal-1",
    linkedAt: NOW,
    unlinkedAt: null,
    unlinkReason: null,
    ...overrides,
  };
}

/** 検索条件（既定値つき）。`includeDeleted` は false、`limit` は 100 */
export const makeReceiptQuery = (input: ReceiptQueryInput = {}): ReceiptQuery =>
  ReceiptQuery.parse(input);
