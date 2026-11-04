import { RECEIPT_MAX_PIXELS, type ReceiptMediaType, type ReceiptQuery } from "@trebuchet/schema";
import {
  type ReceiptFileStore,
  type ReceiptImageTool,
  type ReceiptProbe,
  type ReceiptReader,
  type ReceiptReadingRequest,
  type ReceiptStore,
  RepositoryConflictError,
} from "../../src/ports.ts";
import { linkStateOf } from "../../src/receipts/history.ts";
import { matchesReceiptQuery } from "../../src/receipts/search.ts";
import {
  domainError,
  err,
  type JournalRef,
  ok,
  type ReadingOutcome,
  type ReceiptAuditEntry,
  type ReceiptFileRow,
  type ReceiptLinkRow,
  type ReceiptReadingRow,
  type ReceiptRow,
  type ReceiptSearchRow,
  type Result,
} from "../../src/types.ts";
import { jpegBytes, jpegDimensions, pngDimensions } from "../fixtures/receipts/sample-files.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { sha256Hex } from "./sha256.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type ReceiptState = {
  receipts: ReceiptRow[];
  files: ReceiptFileRow[];
  links: ReceiptLinkRow[];
  readings: ReceiptReadingRow[];
  audits: ReceiptAuditEntry[];
};

const OUTCOME_KEYS = [
  "dateMatch",
  "amountMatch",
  "partnerMatch",
  "accountMatch",
  "taxMatch",
] as const;

/**
 * ReceiptStore のフェイク（data-model §1 の表と同じ性質）。DB の制約のうち次を確かめる:
 * 受領日時・経路・ID の不変、削除の取り消しの禁止、`sha256` の一意、ファイルの版は 1 から連番、
 * 有効な結びつきは証憑ごとに 1 件、結びつきは 1 回だけ閉じる、読み取りの比べは列ごとに 1 回。
 * `journalOf` は `search` が結びつきの仕訳の状態を引くのに使う（`fakeReceiptUnitOfWork` が帳簿につなぐ）
 */
export class FakeReceiptStore implements ReceiptStore {
  state: ReceiptState = { receipts: [], files: [], links: [], readings: [], audits: [] };
  journalOf: ((id: string) => JournalRef | undefined) | undefined;

  constructor(journalOf?: (id: string) => JournalRef | undefined) {
    this.journalOf = journalOf;
  }

  insertReceipt(row: ReceiptRow): void {
    if (this.state.receipts.some((r) => r.id === row.id)) {
      throw new Error(`receipt already exists: ${row.id}`);
    }
    this.state.receipts.push(structuredClone(row));
  }

  updateReceipt(row: ReceiptRow, expectedVersion: number): void {
    const current = this.state.receipts.find((r) => r.id === row.id);
    if (current === undefined) throw new Error(`receipt not found: ${row.id}`);
    if (current.version !== expectedVersion) {
      throw new RepositoryConflictError("証憑は他の操作で変更されています");
    }
    if (row.receivedAt !== current.receivedAt || row.channel !== current.channel) {
      throw new Error("receivedAt・channel は変えられない");
    }
    if (current.deletedAt !== null && row.deletedAt !== current.deletedAt) {
      throw new Error("削除は取り消せない");
    }
    this.state.receipts = this.state.receipts.map((r) =>
      r.id === row.id ? structuredClone(row) : r,
    );
  }

  getReceipt(id: string): ReceiptRow | undefined {
    const found = this.state.receipts.find((r) => r.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  /** 版は 1 から連番（DB は UNIQUE と ≥ 1 だけだが、フェイクは抜けも拒んで取り違えに気づけるようにする） */
  insertFile(row: ReceiptFileRow): void {
    if (this.state.files.some((f) => f.sha256 === row.sha256)) {
      throw new Error(`sha256 already exists: ${row.sha256}`);
    }
    const versions = this.state.files.filter((f) => f.receiptId === row.receiptId).length;
    if (row.fileVersion !== versions + 1) {
      throw new Error(`file_version は ${versions + 1} のはず: ${row.fileVersion}`);
    }
    this.state.files.push(structuredClone(row));
  }

  listFiles(receiptId: string): ReceiptFileRow[] {
    return structuredClone(
      this.state.files
        .filter((f) => f.receiptId === receiptId)
        .sort((a, b) => a.fileVersion - b.fileVersion),
    );
  }

  findFileBySha(sha256: string): ReceiptFileRow | undefined {
    const found = this.state.files.find((f) => f.sha256 === sha256);
    return found === undefined ? undefined : structuredClone(found);
  }

  /** `received_at DESC, id DESC`。カーソルは直前のページの終わり（`<受領日時>|<ID>`） */
  search(query: ReceiptQuery): { rows: ReceiptSearchRow[]; nextCursor: string | null } {
    const matched = this.state.receipts
      .map((receipt) => {
        const link = this.activeLink(receipt.id);
        const journal = link === undefined ? undefined : this.journalOf?.(link.journalId);
        return { receipt, link, journal };
      })
      .filter(({ receipt, link, journal }) =>
        matchesReceiptQuery(receipt, linkStateOf(link, journal?.status), query),
      )
      // コードユニットの順（カーソルの比べと同じ。SQLite の BINARY の照合順序と同じ）
      .sort((a, b) => {
        const x = `${a.receipt.receivedAt}|${a.receipt.id}`;
        const y = `${b.receipt.receivedAt}|${b.receipt.id}`;
        return x < y ? 1 : x > y ? -1 : 0;
      });
    const { cursor } = query;
    const rest =
      cursor === undefined
        ? matched
        : matched.filter(({ receipt }) => `${receipt.receivedAt}|${receipt.id}` < cursor);
    const page = rest.slice(0, query.limit);
    const last = page.at(-1);
    const rows = page.map(({ receipt, link, journal }): ReceiptSearchRow => {
      const currentFile = this.state.files.find((f) => f.sha256 === receipt.currentSha256);
      if (currentFile === undefined) throw new Error(`current file not found: ${receipt.id}`);
      return structuredClone({ receipt, currentFile, link, journal });
    });
    return {
      rows,
      nextCursor:
        rest.length > query.limit && last !== undefined
          ? `${last.receipt.receivedAt}|${last.receipt.id}`
          : null,
    };
  }

  /** `search` と同じ条件に合う件数（ページは見ない） */
  count(query: ReceiptQuery): number {
    return this.state.receipts.filter((receipt) => {
      const link = this.activeLink(receipt.id);
      const journal = link === undefined ? undefined : this.journalOf?.(link.journalId);
      return matchesReceiptQuery(receipt, linkStateOf(link, journal?.status), query);
    }).length;
  }

  getActiveLink(receiptId: string): ReceiptLinkRow | undefined {
    const found = this.activeLink(receiptId);
    return found === undefined ? undefined : structuredClone(found);
  }

  insertLink(row: ReceiptLinkRow): void {
    if (row.unlinkedAt === null && this.activeLink(row.receiptId) !== undefined) {
      throw new Error(`active link already exists: ${row.receiptId}`);
    }
    this.state.links.push(structuredClone(row));
  }

  closeLink(id: string, at: string, reason: string): void {
    const link = this.state.links.find((l) => l.id === id);
    if (link === undefined) throw new Error(`link not found: ${id}`);
    if (link.unlinkedAt !== null) throw new Error(`link already closed: ${id}`);
    link.unlinkedAt = at;
    link.unlinkReason = reason;
  }

  listActiveLinksByJournal(journalId: string): ReceiptLinkRow[] {
    return structuredClone(
      this.state.links.filter((l) => l.journalId === journalId && l.unlinkedAt === null),
    );
  }

  /** 有効な結びつきのある仕訳だけを載せる（SQL の GROUP BY と同じ） */
  countActiveLinksByJournal(journalIds: readonly string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const link of this.state.links) {
      if (link.unlinkedAt !== null || !journalIds.includes(link.journalId)) continue;
      counts.set(link.journalId, (counts.get(link.journalId) ?? 0) + 1);
    }
    return counts;
  }

  insertReading(row: ReceiptReadingRow): void {
    if (this.state.readings.some((r) => r.id === row.id)) {
      throw new Error(`reading already exists: ${row.id}`);
    }
    this.state.readings.push(structuredClone(row));
  }

  listReadings(receiptId: string): ReceiptReadingRow[] {
    return structuredClone(this.state.readings.filter((r) => r.receiptId === receiptId));
  }

  setReadingOutcome(id: string, outcome: Partial<ReadingOutcome>, at: string): void {
    const reading = this.state.readings.find((r) => r.id === id);
    if (reading === undefined) throw new Error(`reading not found: ${id}`);
    let wrote = false;
    for (const key of OUTCOME_KEYS) {
      const value = outcome[key];
      if (value !== undefined && reading[key] === null) {
        reading[key] = value;
        wrote = true;
      }
    }
    if (wrote && reading.comparedAt === null) reading.comparedAt = at;
  }

  appendAudit(entry: ReceiptAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  /**
   * 古い順。追加・更新などは `targetId` が証憑の ID。結びつき・読み取りの記録は、`beforeJson`・
   * `afterJson` の `receiptId` が証憑の ID のものを含める（`targetId` は結びつき・読み取りの ID でもよい）
   */
  listAudit(receiptId: string): ReceiptAuditEntry[] {
    return structuredClone(
      this.state.audits.filter(
        (e) =>
          e.targetId === receiptId ||
          receiptIdOf(e.beforeJson) === receiptId ||
          receiptIdOf(e.afterJson) === receiptId,
      ),
    );
  }

  get audits(): ReceiptAuditEntry[] {
    return this.state.audits;
  }

  private activeLink(receiptId: string): ReceiptLinkRow | undefined {
    return this.state.links.find((l) => l.receiptId === receiptId && l.unlinkedAt === null);
  }
}

function receiptIdOf(json: string | null): string | undefined {
  if (json === null) return undefined;
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { receiptId?: unknown }).receiptId;
  return typeof id === "string" ? id : undefined;
}

/**
 * ReceiptUnitOfWork のフェイク（INV-62・64。db の `drizzleUnitOfWork` と同じ性質）。
 * `uow.ledger` で帳簿を参照でき、`uow.receipts.search` は帳簿の仕訳の状態を使う
 */
export const fakeReceiptUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  receipts = new FakeReceiptStore(),
) => {
  receipts.journalOf ??= (id) => {
    const journal = ledger.getJournal(id);
    return journal === undefined
      ? undefined
      : {
          id: journal.id,
          journalNo: journal.journalNo,
          date: journal.date,
          status: journal.status,
        };
  };
  return fakeUnitOfWork(ledger, masters, { receipts });
};
export type FakeReceiptUnitOfWork = ReturnType<typeof fakeReceiptUnitOfWork>;

const unreadable = (message: string): Error => {
  const error = new Error(message);
  error.name = "ReceiptFileUnreadableError";
  return error;
};

/**
 * ReceiptFileStore のフェイク（メモリー。暗号化はしない）。`puts` は実際に書いた名前、
 * `discarded` は `discard` した名前（INV-62 ③ の確認用）。`failOnPut` なら `put` は何も残さず例外。
 * `tamper` は中身を 1 バイト変える（`read` が SHA-256 の不一致で失敗する）
 */
export class FakeReceiptFileStore implements ReceiptFileStore {
  readonly files = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly discarded: string[] = [];
  failOnPut = false;

  digest(bytes: Uint8Array): string {
    return sha256Hex(bytes);
  }

  has(sha256: string): boolean {
    return this.files.has(sha256);
  }

  put(sha256: string, bytes: Uint8Array): void {
    if (this.failOnPut) throw new Error("injected failure: put");
    if (this.files.has(sha256)) return;
    this.files.set(sha256, new Uint8Array(bytes));
    this.puts.push(sha256);
  }

  /** 欠け・改ざんは db の `ReceiptFileUnreadableError` と同じ名前の例外（domain は名前で見分ける） */
  read(sha256: string): Uint8Array {
    const bytes = this.files.get(sha256);
    if (bytes === undefined) throw unreadable(`receipt file not found: ${sha256}`);
    if (sha256Hex(bytes) !== sha256) throw unreadable(`receipt file unreadable: ${sha256}`);
    return new Uint8Array(bytes);
  }

  discard(sha256: string): void {
    this.files.delete(sha256);
    this.discarded.push(sha256);
  }

  tamper(sha256: string): void {
    const bytes = this.files.get(sha256);
    if (bytes === undefined) throw new Error(`receipt file not found: ${sha256}`);
    const changed = new Uint8Array(bytes);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;
    this.files.set(sha256, changed);
  }
}

/**
 * ReceiptImageTool のフェイク。既定の `probe` は JPEG・PNG のヘッダーから寸法を読み（フルカラー）、
 * HEIC は固定の寸法、PDF は調べられない（`ok(undefined)`）。`width × height` が `RECEIPT_MAX_PIXELS` を
 * 超えれば `VALIDATION`（`details.maxPixels`）。`respond*` で結果を差し替える。`calls` は呼び出しの記録
 */
export class FakeImageTool implements ReceiptImageTool {
  readonly calls: { method: "probe" | "toDisplay" | "toAiJpeg"; mediaType: ReceiptMediaType }[] =
    [];
  private probeResponse: Result<ReceiptProbe | undefined> | undefined;
  private displayResponse: Result<{ bytes: Uint8Array; mediaType: string }> | undefined;
  private aiJpegResponse: Result<Uint8Array> | undefined;

  respondProbe(response: Result<ReceiptProbe | undefined> | undefined): void {
    this.probeResponse = response;
  }
  respondDisplay(response: Result<{ bytes: Uint8Array; mediaType: string }> | undefined): void {
    this.displayResponse = response;
  }
  respondAiJpeg(response: Result<Uint8Array> | undefined): void {
    this.aiJpegResponse = response;
  }

  async probe(
    bytes: Uint8Array,
    mediaType: ReceiptMediaType,
  ): Promise<Result<ReceiptProbe | undefined>> {
    this.calls.push({ method: "probe", mediaType });
    if (this.probeResponse !== undefined) return this.probeResponse;
    if (mediaType === "application/pdf") return ok(undefined);
    let size: { width: number; height: number };
    try {
      if (mediaType === "image/jpeg") size = jpegDimensions(bytes);
      else if (mediaType === "image/png") size = pngDimensions(bytes);
      else size = { width: 4032, height: 3024 };
    } catch {
      return err(domainError("VALIDATION", "画像を読めません"));
    }
    if (size.width * size.height > RECEIPT_MAX_PIXELS) {
      return err(
        domainError("VALIDATION", "画像の画素数が多すぎます", { maxPixels: RECEIPT_MAX_PIXELS }),
      );
    }
    return ok({ ...size, fullColor: true });
  }

  async toDisplay(
    bytes: Uint8Array,
    mediaType: ReceiptMediaType,
  ): Promise<Result<{ bytes: Uint8Array; mediaType: string }>> {
    this.calls.push({ method: "toDisplay", mediaType });
    if (this.displayResponse !== undefined) return this.displayResponse;
    if (mediaType === "image/heic") return ok({ bytes: jpegBytes(), mediaType: "image/jpeg" });
    return ok({ bytes: new Uint8Array(bytes), mediaType });
  }

  async toAiJpeg(
    bytes: Uint8Array,
    mediaType: ReceiptMediaType,
    _maxPx: number,
  ): Promise<Result<Uint8Array>> {
    this.calls.push({ method: "toAiJpeg", mediaType });
    if (this.aiJpegResponse !== undefined) return this.aiJpegResponse;
    return ok(mediaType === "image/jpeg" ? new Uint8Array(bytes) : jpegBytes());
  }
}

/**
 * ReceiptReader のフェイク。既定は読めない（`read` は失敗）。`respondWith` で応答の `content` を決め、
 * `calls` で渡された要求（INV-66）を確かめる。`throwOnCall` を立てると `read` が例外を投げる。AI は呼ばない
 */
export class FakeReceiptReader implements ReceiptReader {
  readonly calls: ReceiptReadingRequest[] = [];
  modelCalls = 0;
  throwOnCall = false;
  private modelName: string | undefined;
  private response: Result<unknown> = err(domainError("VALIDATION", "AI を使えません"));

  constructor(options: { model?: string | undefined } = {}) {
    this.modelName = "model" in options ? options.model : "fake-model";
  }

  setModel(model: string | undefined): void {
    this.modelName = model;
  }

  respondWith(response: Result<unknown>): void {
    this.response = response;
  }

  async model(): Promise<string | undefined> {
    this.modelCalls += 1;
    return this.modelName;
  }

  async read(request: ReceiptReadingRequest): Promise<Result<unknown>> {
    this.calls.push(structuredClone(request));
    if (this.throwOnCall) throw new Error("boom");
    return this.response;
  }
}
