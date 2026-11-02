import {
  escapeLike,
  type JournalRef,
  normalizeReceiptText,
  type ReadingOutcome,
  type ReceiptAuditEntry,
  type ReceiptFileRow,
  type ReceiptLinkRow,
  type ReceiptReadingRow,
  type ReceiptRow,
  type ReceiptSearchRow,
  type ReceiptStore,
  type ReceiptUnitOfWork,
  RepositoryConflictError,
} from "@trebuchet/domain";
import type { ReceiptQuery } from "@trebuchet/schema";
import { and, asc, count, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { asTaxCategory, insertionOrder, rowidOf, type TenantConn } from "./internal.ts";
import {
  journals,
  receiptAuditLog,
  receiptFiles,
  receiptLinks,
  receiptReadings,
  receipts,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

type FileRecord = typeof receiptFiles.$inferSelect;
type ReadingRecord = typeof receiptReadings.$inferSelect;
type AuditRecord = typeof receiptAuditLog.$inferSelect;

const toFile = (row: FileRecord): ReceiptFileRow => ({
  ...row,
  fullColor: row.fullColor === null ? null : row.fullColor === 1,
});

const fromFile = (row: ReceiptFileRow): FileRecord => ({
  ...row,
  fullColor: row.fullColor === null ? null : row.fullColor ? 1 : 0,
});

const flag = (value: number | null): boolean | null => (value === null ? null : value === 1);
const bit = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0);

const toReading = (row: ReadingRecord): ReceiptReadingRow => ({
  ...row,
  candTaxCategory: row.candTaxCategory === null ? null : asTaxCategory(row.candTaxCategory),
  dateMatch: flag(row.dateMatch),
  amountMatch: flag(row.amountMatch),
  partnerMatch: flag(row.partnerMatch),
  accountMatch: flag(row.accountMatch),
  taxMatch: flag(row.taxMatch),
});

const fromReading = (row: ReceiptReadingRow): ReadingRecord => ({
  ...row,
  dateMatch: bit(row.dateMatch),
  amountMatch: bit(row.amountMatch),
  partnerMatch: bit(row.partnerMatch),
  accountMatch: bit(row.accountMatch),
  taxMatch: bit(row.taxMatch),
});

const toAudit = (row: AuditRecord): ReceiptAuditEntry => ({
  id: row.id,
  occurredAt: row.occurredAt,
  targetType: row.targetType,
  targetId: row.targetId,
  action: row.action,
  reason: row.reason,
  beforeJson: row.beforeJson,
  afterJson: row.afterJson,
});

/** 値の比べの列（`ReadingOutcome` のキー → 表の列） */
const OUTCOME_COLUMNS = {
  dateMatch: receiptReadings.dateMatch,
  amountMatch: receiptReadings.amountMatch,
  partnerMatch: receiptReadings.partnerMatch,
  accountMatch: receiptReadings.accountMatch,
  taxMatch: receiptReadings.taxMatch,
} as const;
const OUTCOME_KEYS = Object.keys(OUTCOME_COLUMNS) as (keyof ReadingOutcome)[];

/** 履歴の JSON の `receiptId`（結びつき・読み取りの記録が、どの証憑のものかを示す） */
function receiptIdIn(json: string | null): string | undefined {
  if (json === null) return undefined;
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { receiptId?: unknown }).receiptId;
  return typeof id === "string" ? id : undefined;
}

/** `<受領日時>|<ID>` のカーソルを分ける。形が違えば undefined */
function splitCursor(cursor: string): { receivedAt: string; id: string } | undefined {
  const at = cursor.indexOf("|");
  if (at <= 0 || at === cursor.length - 1) return undefined;
  return { receivedAt: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

/**
 * ReceiptStore の Drizzle（better-sqlite3）による実装（data-model §1、contracts/domain-module.md §4）。
 * メソッドはすべて同期。`UnitOfWork.run` の中で使う。履歴（`receipt_audit_log`）は追記のみ。
 * 循環した外部キー（`receipts.current_sha256` ⇔ `receipt_files.receipt_id`）はコミットで検査される
 */
export class DrizzleReceiptStore implements ReceiptStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  insertReceipt(row: ReceiptRow): void {
    this.db.insert(receipts).values(row).run();
  }

  updateReceipt(row: ReceiptRow, expectedVersion: number): void {
    const result = this.db
      .update(receipts)
      .set({
        category: row.category,
        currentSha256: row.currentSha256,
        transactionDate: row.transactionDate,
        amount: row.amount,
        partnerName: row.partnerName,
        partnerKey: row.partnerKey,
        memo: row.memo,
        deletedAt: row.deletedAt,
        deletedReason: row.deletedReason,
        version: row.version,
        updatedAt: row.updatedAt,
        // 受領日時・経路・ID は変えない（トリガーも禁止する）。値が違えばトリガーが止める
        receivedAt: row.receivedAt,
        channel: row.channel,
      })
      .where(and(eq(receipts.id, row.id), eq(receipts.version, expectedVersion)))
      .run();
    if (result.changes === 1) return;
    if (this.getReceipt(row.id) === undefined) throw new Error(`receipt not found: ${row.id}`);
    throw new RepositoryConflictError(`receipt ${row.id} is not at version ${expectedVersion}`);
  }

  getReceipt(id: string): ReceiptRow | undefined {
    return this.db.select().from(receipts).where(eq(receipts.id, id)).get();
  }

  insertFile(row: ReceiptFileRow): void {
    this.db.insert(receiptFiles).values(fromFile(row)).run();
  }

  listFiles(receiptId: string): ReceiptFileRow[] {
    return this.db
      .select()
      .from(receiptFiles)
      .where(eq(receiptFiles.receiptId, receiptId))
      .orderBy(asc(receiptFiles.fileVersion))
      .all()
      .map(toFile);
  }

  findFileBySha(sha256: string): ReceiptFileRow | undefined {
    const row = this.db.select().from(receiptFiles).where(eq(receiptFiles.sha256, sha256)).get();
    return row === undefined ? undefined : toFile(row);
  }

  /** `received_at DESC, id DESC`（カーソルは直前のページの終わり `<受領日時>|<ID>`）。`limit + 1` 件を読んで次の有無を知る */
  search(query: ReceiptQuery): { rows: ReceiptSearchRow[]; nextCursor: string | null } {
    const conditions: SQL[] = [];
    if (!query.includeDeleted) conditions.push(isNull(receipts.deletedAt));
    if (query.dateFrom !== undefined)
      conditions.push(sql`${receipts.transactionDate} >= ${query.dateFrom}`);
    if (query.dateTo !== undefined)
      conditions.push(sql`${receipts.transactionDate} <= ${query.dateTo}`);
    if (query.amountMin !== undefined)
      conditions.push(sql`${receipts.amount} >= ${query.amountMin}`);
    if (query.amountMax !== undefined)
      conditions.push(sql`${receipts.amount} <= ${query.amountMax}`);
    if (query.partner !== undefined) {
      const term = escapeLike(normalizeReceiptText(query.partner));
      conditions.push(sql`${receipts.partnerKey} LIKE ${`%${term}%`} ESCAPE '\\'`);
    }
    if (query.category !== undefined) conditions.push(eq(receipts.category, query.category));
    if (query.missing === true) {
      conditions.push(
        sql`(${receipts.transactionDate} IS NULL OR ${receipts.amount} IS NULL OR ${receipts.partnerName} IS NULL)`,
      );
    }
    if (query.link === "none") conditions.push(sql`${receiptLinks.id} IS NULL`);
    if (query.link === "linked") {
      conditions.push(sql`(${receiptLinks.id} IS NOT NULL AND ${journals.status} IS NOT 'voided')`);
    }
    if (query.link === "journal_voided") {
      conditions.push(sql`(${receiptLinks.id} IS NOT NULL AND ${journals.status} = 'voided')`);
    }
    if (query.cursor !== undefined) {
      const cursor = splitCursor(query.cursor);
      if (cursor === undefined) return { rows: [], nextCursor: null };
      conditions.push(
        sql`(${receipts.receivedAt} < ${cursor.receivedAt} OR (${receipts.receivedAt} = ${cursor.receivedAt} AND ${receipts.id} < ${cursor.id}))`,
      );
    }

    const found = this.db
      .select({
        receipt: receipts,
        currentFile: receiptFiles,
        link: receiptLinks,
        journal: {
          id: journals.id,
          journalNo: journals.journalNo,
          date: journals.date,
          status: journals.status,
        },
      })
      .from(receipts)
      .innerJoin(receiptFiles, eq(receiptFiles.sha256, receipts.currentSha256))
      .leftJoin(
        receiptLinks,
        and(eq(receiptLinks.receiptId, receipts.id), isNull(receiptLinks.unlinkedAt)),
      )
      .leftJoin(journals, eq(journals.id, receiptLinks.journalId))
      .where(and(...conditions))
      .orderBy(sql`${receipts.receivedAt} DESC`, sql`${receipts.id} DESC`)
      .limit(query.limit + 1)
      .all();

    const page = found.slice(0, query.limit);
    const last = page.at(-1)?.receipt;
    const rows = page.map(
      (r): ReceiptSearchRow => ({
        receipt: r.receipt,
        currentFile: toFile(r.currentFile),
        link: r.link ?? undefined,
        // 結びつきがなければ LEFT JOIN で全部 null になる
        journal: r.link === null || r.journal === null ? undefined : (r.journal as JournalRef),
      }),
    );
    return {
      rows,
      nextCursor:
        found.length > query.limit && last !== undefined ? `${last.receivedAt}|${last.id}` : null,
    };
  }

  getActiveLink(receiptId: string): ReceiptLinkRow | undefined {
    return this.db
      .select()
      .from(receiptLinks)
      .where(and(eq(receiptLinks.receiptId, receiptId), isNull(receiptLinks.unlinkedAt)))
      .get();
  }

  insertLink(row: ReceiptLinkRow): void {
    this.db.insert(receiptLinks).values(row).run();
  }

  closeLink(id: string, at: string, reason: string): void {
    const result = this.db
      .update(receiptLinks)
      .set({ unlinkedAt: at, unlinkReason: reason })
      .where(and(eq(receiptLinks.id, id), isNull(receiptLinks.unlinkedAt)))
      .run();
    if (result.changes !== 1) throw new Error(`active link not found: ${id}`);
  }

  listActiveLinksByJournal(journalId: string): ReceiptLinkRow[] {
    return this.db
      .select()
      .from(receiptLinks)
      .where(and(eq(receiptLinks.journalId, journalId), isNull(receiptLinks.unlinkedAt)))
      .orderBy(rowidOf(receiptLinks))
      .all();
  }

  /** 1 回の GROUP BY。有効な結びつきのある仕訳だけを載せる */
  countActiveLinksByJournal(journalIds: readonly string[]): Map<string, number> {
    if (journalIds.length === 0) return new Map();
    const rows = this.db
      .select({ journalId: receiptLinks.journalId, n: count() })
      .from(receiptLinks)
      .where(and(isNull(receiptLinks.unlinkedAt), inArray(receiptLinks.journalId, [...journalIds])))
      .groupBy(receiptLinks.journalId)
      .all();
    return new Map(rows.map((r) => [r.journalId, r.n]));
  }

  insertReading(row: ReceiptReadingRow): void {
    this.db.insert(receiptReadings).values(fromReading(row)).run();
  }

  listReadings(receiptId: string): ReceiptReadingRow[] {
    return this.db
      .select()
      .from(receiptReadings)
      .where(eq(receiptReadings.receiptId, receiptId))
      .orderBy(rowidOf(receiptReadings))
      .all()
      .map(toReading);
  }

  /**
   * 渡した比べのうち、列が NULL のものだけに書く（L2）。`UPDATE OF <列>` のトリガーは SET の列に
   * 触れただけで働くので、書く列だけを SET に入れる。`compared_at` は何かを書くときに NULL なら `at`
   */
  setReadingOutcome(id: string, outcome: Partial<ReadingOutcome>, at: string): void {
    const current = this.db.select().from(receiptReadings).where(eq(receiptReadings.id, id)).get();
    if (current === undefined) throw new Error(`reading not found: ${id}`);
    const set: Partial<Record<keyof ReadingOutcome, number>> & { comparedAt?: string } = {};
    for (const key of OUTCOME_KEYS) {
      const value = outcome[key];
      if (value !== undefined && current[key] === null) set[key] = value ? 1 : 0;
    }
    if (Object.keys(set).length === 0) return;
    if (current.comparedAt === null) set.comparedAt = at;
    this.db.update(receiptReadings).set(set).where(eq(receiptReadings.id, id)).run();
  }

  /**
   * 履歴を追記する。`receipt_id` は記録の対象の証憑: `receipt` は `target_id`、`receipt_link` は
   * `receiptId`（結びつけは after、解除は before。なければ結びつきの行から）、`receipt_reading` は after の
   * `receiptId`（data-model §2.5）。決められなければ例外
   */
  appendAudit(entry: ReceiptAuditEntry): void {
    const receiptId = this.receiptIdOf(entry);
    if (receiptId === undefined) {
      throw new Error(`cannot determine the receipt of the audit entry: ${entry.targetType}`);
    }
    this.db
      .insert(receiptAuditLog)
      .values({
        id: entry.id,
        occurredAt: entry.occurredAt,
        receiptId,
        targetType: entry.targetType,
        targetId: entry.targetId,
        action: entry.action,
        reason: entry.reason,
        beforeJson: entry.beforeJson,
        afterJson: entry.afterJson,
      })
      .run();
  }

  listAudit(receiptId: string): ReceiptAuditEntry[] {
    return this.db
      .select()
      .from(receiptAuditLog)
      .where(eq(receiptAuditLog.receiptId, receiptId))
      .orderBy(insertionOrder)
      .all()
      .map(toAudit);
  }

  private receiptIdOf(entry: ReceiptAuditEntry): string | undefined {
    if (entry.targetType === "receipt") return entry.targetId;
    const fromJson = receiptIdIn(entry.afterJson) ?? receiptIdIn(entry.beforeJson);
    if (fromJson !== undefined || entry.targetType === "receipt_reading") return fromJson;
    return this.db
      .select({ receiptId: receiptLinks.receiptId })
      .from(receiptLinks)
      .where(eq(receiptLinks.id, entry.targetId))
      .get()?.receiptId;
  }
}

/** ReceiptUnitOfWork の実装。仕訳・マスタ・証憑の記録を同じトランザクションで扱う（INV-62・64） */
export const createReceiptUnitOfWork = (db: TenantConn): ReceiptUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ receipts: new DrizzleReceiptStore(tx) }));
