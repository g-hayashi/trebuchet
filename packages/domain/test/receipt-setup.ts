import { ReceiptQuery, type ReceiptQueryInput } from "@trebuchet/schema";
import { normalizeReceiptText } from "../src/receipts/search.ts";
import type { Journal, ReceiptFileRow, ReceiptLinkRow, ReceiptRow } from "../src/types.ts";
import type { ReceiptDeps } from "../src/usecases/receipts.ts";
import {
  FakeReceiptFileStore,
  type FakeReceiptUnitOfWork,
  FixedClock,
  fakeReceiptUnitOfWork,
  SequentialIds,
} from "./fakes.ts";
import { NOW } from "./test-dates.ts";

/** `Asia/Tokyo` の日付（`ReceiptDeps.dateOf` の偽物。UTC に 9 時間を足す。テスト専用） */
export const jstDateOf = (iso: string): string =>
  new Date(Date.parse(iso) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * 証憑のユースケースのテストが共有する準備: 偽の UnitOfWork・ファイル・時計・ID と、それらの `deps`。
 * 時刻は `now`（既定は `NOW`）。障害の注入をするときは `deps.uow` を差し替える
 */
export function setupReceipts(options: { now?: string } = {}) {
  const uow: FakeReceiptUnitOfWork = fakeReceiptUnitOfWork();
  const files = new FakeReceiptFileStore();
  const clock = new FixedClock(options.now ?? NOW);
  const ids = new SequentialIds();
  const deps: ReceiptDeps = { uow, files, clock, ids, dateOf: jstDateOf };
  return { uow, files, clock, ids, deps };
}

/** 帳簿に最小の仕訳（行なし）を足す。結びつきの相手として使う。名前・金額はなし */
export function addBareJournal(
  uow: FakeReceiptUnitOfWork,
  over: Partial<Journal> & { id: string },
): Journal {
  const journal: Journal = {
    journalNo: uow.ledger.nextJournalNo(),
    date: "2026-10-20",
    fiscalPeriodId: "period-1",
    memo: null,
    status: "active",
    correctsJournalId: null,
    source: "manual",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [],
    ...over,
  };
  uow.ledger.state.journals.push(journal);
  return structuredClone(journal);
}

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
