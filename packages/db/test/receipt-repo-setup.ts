import { randomUUIDv7 } from "node:crypto";
import {
  normalizeReceiptText,
  ok,
  type ReceiptFileRow,
  type ReceiptLinkRow,
  type ReceiptReadingRow,
  type ReceiptRow,
  type ReceiptStore,
} from "@trebuchet/domain";
import { createReceiptUnitOfWork } from "../src/receipt-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { NOW } from "../src/testing.ts";
import { receiptDb } from "./receipt-db-setup.ts";

// 010 の db のリポジトリのテストの共通の準備（domain の行の型で作る）

export const fakeSha = (n: number): string => n.toString(16).padStart(64, "0");

export function makeReceipt(over: Partial<ReceiptRow> = {}): ReceiptRow {
  const partnerName = over.partnerName === undefined ? null : over.partnerName;
  return {
    id: randomUUIDv7(),
    receivedAt: NOW,
    channel: "local",
    category: "paper_scan",
    currentSha256: fakeSha(1),
    transactionDate: null,
    amount: null,
    partnerName,
    partnerKey: partnerName === null ? null : normalizeReceiptText(partnerName),
    memo: null,
    deletedAt: null,
    deletedReason: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function makeFile(receiptId: string, over: Partial<ReceiptFileRow> = {}): ReceiptFileRow {
  return {
    sha256: fakeSha(1),
    receiptId,
    fileVersion: 1,
    mediaType: "image/jpeg",
    sizeBytes: 1000,
    originalName: "scan.jpg",
    width: 2400,
    height: 1700,
    fullColor: true,
    addedAt: NOW,
    channel: "local",
    ...over,
  };
}

export function makeLink(
  receiptId: string,
  journalId: string,
  over: Partial<ReceiptLinkRow> = {},
): ReceiptLinkRow {
  return {
    id: randomUUIDv7(),
    receiptId,
    journalId,
    linkedAt: NOW,
    unlinkedAt: null,
    unlinkReason: null,
    ...over,
  };
}

export function makeReading(
  receiptId: string,
  fileSha256: string,
  over: Partial<ReceiptReadingRow> = {},
): ReceiptReadingRow {
  return {
    id: randomUUIDv7(),
    receiptId,
    fileSha256,
    readAt: NOW,
    model: "gpt-x",
    status: "succeeded",
    errorCode: null,
    candDate: "2026-10-31",
    candAmount: 1100,
    candPartner: "店",
    candAccountCode: "5200",
    candTaxCategory: "PURCHASE_10",
    confidence: 80,
    comparedAt: null,
    dateMatch: null,
    amountMatch: null,
    partnerMatch: null,
    accountMatch: null,
    taxMatch: null,
    ...over,
  };
}

/** 事業体の DB（マイグレーション済み）と実際の ReceiptUnitOfWork（`foreign_keys=ON`） */
export function setupReceiptDb() {
  const db: TenantDb = openTenant(randomUUIDv7());
  const uow = createReceiptUnitOfWork(db);
  const raw = receiptDb(db);

  /** 1 つのトランザクションの中で `fn` を実行する（ok で確定） */
  function inUow<T>(fn: (receipts: ReceiptStore) => T): T {
    let value: T | undefined;
    const result = uow.run((tx) => {
      value = fn(tx.receipts);
      return ok(undefined);
    });
    if (!result.ok) throw new Error("unexpected err");
    return value as T;
  }

  /** 追加（証憑 → ファイルの順）。同じ sha の別の証憑は作れない */
  function add(receiptOver: Partial<ReceiptRow> = {}, fileOver: Partial<ReceiptFileRow> = {}) {
    const receipt = makeReceipt(receiptOver);
    const file = makeFile(receipt.id, { sha256: receipt.currentSha256, ...fileOver });
    inUow((r) => {
      r.insertReceipt(receipt);
      r.insertFile(file);
    });
    return { receipt, file };
  }

  return { db, uow, raw, inUow, add };
}
