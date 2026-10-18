import type {
  AuditEntry,
  Journal,
  JournalLine,
  JournalRepository,
  NewJournal,
  TaxCategoryCode,
} from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import { asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as tenantSchema from "./schema/tenant.ts";
import { auditLog, journalLines, journalLineTags, journals } from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

type JournalRow = typeof journals.$inferSelect;

/**
 * JournalRepository の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 訂正・取消・検索・帳票の集計（LedgerRepository の残り）は US3 以降で加える
 */
export class DrizzleLedgerRepository implements JournalRepository {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  /** SQLite のトランザクション（入れ子は SAVEPOINT）。例外でロールバックする */
  transaction<T>(fn: (tx: JournalRepository) => T): T {
    return this.db.transaction((tx) => fn(new DrizzleLedgerRepository(tx)));
  }

  appendAudit(entry: AuditEntry): void {
    this.db.insert(auditLog).values(entry).run();
  }

  nextJournalNo(): number {
    const row = this.db
      .select({ max: max(journals.journalNo) })
      .from(journals)
      .get();
    return (row?.max ?? 0) + 1;
  }

  lastJournal(): Journal | undefined {
    const row = this.db.select().from(journals).orderBy(desc(journals.journalNo)).limit(1).get();
    return row === undefined ? undefined : this.withLines([row])[0];
  }

  insertJournal(journal: NewJournal): Journal {
    const { lines, ...header } = journal;
    const row: JournalRow = {
      ...header,
      status: "active",
      source: "manual",
      version: 1,
      updatedAt: journal.createdAt,
    };
    this.db.transaction((tx) => {
      tx.insert(journals).values(row).run();
      for (const { tagIds, ...line } of lines) {
        tx.insert(journalLines)
          .values({ ...line, journalId: journal.id })
          .run();
        for (const tagId of tagIds) {
          tx.insert(journalLineTags).values({ journalLineId: line.id, tagId }).run();
        }
      }
    });
    return { ...row, lines: lines.map((l) => ({ ...l, tagIds: [...l.tagIds] })) };
  }

  getJournal(id: string): Journal | undefined {
    const row = this.db.select().from(journals).where(eq(journals.id, id)).get();
    return row === undefined ? undefined : this.withLines([row])[0];
  }

  recentJournals(limit: number): Journal[] {
    const rows = this.db
      .select()
      .from(journals)
      .orderBy(desc(journals.date), desc(journals.journalNo))
      .limit(limit)
      .all();
    return this.withLines(rows);
  }

  /** 仕訳の行（行番号の順）とタグ（登録の順）を読み込んで Journal にする */
  private withLines(rows: readonly JournalRow[]): Journal[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const lineRows = this.db
      .select()
      .from(journalLines)
      .where(inArray(journalLines.journalId, ids))
      .orderBy(asc(journalLines.journalId), asc(journalLines.lineNo))
      .all();
    const tagRows = this.db
      .select({ journalLineId: journalLineTags.journalLineId, tagId: journalLineTags.tagId })
      .from(journalLineTags)
      .innerJoin(journalLines, eq(journalLines.id, journalLineTags.journalLineId))
      .where(inArray(journalLines.journalId, ids))
      .orderBy(sql`${journalLineTags}.rowid`)
      .all();

    const tagsByLine = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByLine.get(t.journalLineId) ?? [];
      list.push(t.tagId);
      tagsByLine.set(t.journalLineId, list);
    }
    const linesByJournal = new Map<string, JournalLine[]>();
    for (const { journalId, ...line } of lineRows) {
      const list = linesByJournal.get(journalId) ?? [];
      list.push({
        ...line,
        // tax_category は tax_categories への外部キーで、値は TaxCategoryCode に限られる
        taxCategory: line.taxCategory as TaxCategoryCode,
        tagIds: tagsByLine.get(line.id) ?? [],
      });
      linesByJournal.set(journalId, list);
    }
    return rows.map((r) => ({ ...r, lines: linesByJournal.get(r.id) ?? [] }));
  }
}
