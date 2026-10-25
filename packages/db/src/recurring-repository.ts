import { randomUUID } from "node:crypto";
import type {
  InvoicingAuditEntry,
  RecurringRunRecord,
  RecurringStore,
  RecurringUnitOfWork,
} from "@trebuchet/domain";
import type { Recurring } from "@trebuchet/schema";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { asTaxCategory, type TenantConn } from "./internal.ts";
import { appendInvoicingAuditRow } from "./invoicing-repository.ts";
import { recurringJournalLines, recurringJournals, recurringRuns } from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

/** 行の ID はテナントの DB の中だけで使う（ドメインの `Recurring` は行の ID を持たない） */
const toLineRows = (def: Recurring): (typeof recurringJournalLines.$inferInsert)[] =>
  def.lines.map((line) => ({ ...line, id: randomUUID(), recurringId: def.id }));

/**
 * RecurringStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 一意制約（定義 × 対象月、仕訳）の違反は例外になる（R19）
 */
export class DrizzleRecurringStore implements RecurringStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendRecurringAudit(entry: InvoicingAuditEntry): void {
    appendInvoicingAuditRow(this.db, entry);
  }

  /** 定義の行を行番号の順に読んで、定義に付ける */
  private withLines(rows: (typeof recurringJournals.$inferSelect)[]): Recurring[] {
    if (rows.length === 0) return [];
    const lines = this.db
      .select()
      .from(recurringJournalLines)
      .orderBy(asc(recurringJournalLines.recurringId), asc(recurringJournalLines.lineNo))
      .all();
    return rows.map((row) => ({
      ...row,
      lines: lines
        .filter((l) => l.recurringId === row.id)
        .map(({ id: _id, recurringId: _recurringId, ...line }) => ({
          ...line,
          taxCategory: asTaxCategory(line.taxCategory),
        })),
    }));
  }

  listRecurring(): Recurring[] {
    return this.withLines(
      this.db
        .select()
        .from(recurringJournals)
        .orderBy(asc(recurringJournals.createdAt), asc(recurringJournals.id))
        .all(),
    );
  }

  getRecurring(id: string): Recurring | null {
    return (
      this.withLines(
        this.db.select().from(recurringJournals).where(eq(recurringJournals.id, id)).all(),
      )[0] ?? null
    );
  }

  insertRecurring(def: Recurring): void {
    const { lines: _lines, ...row } = def;
    this.db.transaction((tx) => {
      tx.insert(recurringJournals).values(row).run();
      tx.insert(recurringJournalLines).values(toLineRows(def)).run();
    });
  }

  updateRecurring(def: Recurring): void {
    const { lines: _lines, id, ...row } = def;
    this.db.transaction((tx) => {
      const result = tx
        .update(recurringJournals)
        .set(row)
        .where(eq(recurringJournals.id, id))
        .run();
      if (result.changes !== 1) throw new Error(`定期仕訳がありません: ${id}`);
      tx.delete(recurringJournalLines).where(eq(recurringJournalLines.recurringId, id)).run();
      tx.insert(recurringJournalLines).values(toLineRows(def)).run();
    });
  }

  listRuns(recurringId?: string): RecurringRunRecord[] {
    const query = this.db.select().from(recurringRuns);
    return (
      recurringId === undefined ? query : query.where(eq(recurringRuns.recurringId, recurringId))
    )
      .orderBy(asc(recurringRuns.targetMonth), asc(recurringRuns.createdAt), asc(recurringRuns.id))
      .all();
  }

  insertRun(run: RecurringRunRecord): void {
    this.db.insert(recurringRuns).values(run).run();
  }

  markRunsAcknowledged(runIds: string[], at: string): void {
    if (runIds.length === 0) return;
    const result = this.db
      .update(recurringRuns)
      .set({ acknowledgedAt: at })
      .where(and(inArray(recurringRuns.id, runIds), isNull(recurringRuns.acknowledgedAt)))
      .run();
    if (result.changes !== runIds.length) {
      throw new Error("確認できる回がありません（存在しない、または確認済み）");
    }
  }
}

/** RecurringUnitOfWork の実装。仕訳・マスタ・定期仕訳の記録を同じトランザクションで扱う（R9） */
export const createRecurringUnitOfWork = (db: TenantConn): RecurringUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ recurring: new DrizzleRecurringStore(tx) }));
