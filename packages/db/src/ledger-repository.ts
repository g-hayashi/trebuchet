import {
  type AuditEntry,
  type Journal,
  type JournalLine,
  type JournalQuery,
  type JournalReplacement,
  type LedgerRepository,
  type NewJournal,
  type OpeningBalance,
  type Page,
  type PostedLine,
  type ReportRepository,
  RepositoryConflictError,
  type Result,
} from "@trebuchet/domain";
import type { JournalSummary } from "@trebuchet/schema";
import { and, asc, between, desc, eq, inArray, max, type SQL, sql } from "drizzle-orm";
import { asTaxCategory, rowidOf, type TenantConn } from "./internal.ts";
import { inTransaction } from "./rollback.ts";
import {
  accounts,
  auditLog,
  fiscalPeriods,
  journalLines,
  journalLineTags,
  journals,
  openingBalances,
  partners,
  subAccounts,
} from "./schema/tenant.ts";

type JournalRow = typeof journals.$inferSelect;

const DEFAULT_LIMIT = 50;

/**
 * LedgerRepository と帳票の読み出し（ReportRepository）の Drizzle（better-sqlite3）による実装。
 * メソッドはすべて同期
 */
export class DrizzleLedgerRepository implements LedgerRepository, ReportRepository {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  /** SQLite のトランザクション（入れ子は SAVEPOINT）。`err` か例外でロールバックする */
  transaction<T>(fn: (tx: LedgerRepository) => Result<T>): Result<T> {
    return inTransaction(this.db, (tx) => fn(new DrizzleLedgerRepository(tx)));
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
      source: journal.source ?? "manual",
      version: 1,
      updatedAt: journal.createdAt,
    };
    this.db.transaction((tx) => {
      tx.insert(journals).values(row).run();
      insertLines(tx, journal.id, lines);
    });
    return { ...row, lines: lines.map((l) => ({ ...l, tagIds: [...l.tagIds] })) };
  }

  replaceJournal(
    id: string,
    journal: JournalReplacement,
    expectedVersion: number,
    updatedAt: string,
  ): Journal {
    this.db.transaction((tx) => {
      const result = tx
        .update(journals)
        .set({
          date: journal.date,
          memo: journal.memo,
          correctsJournalId: journal.correctsJournalId,
          version: sql`${journals.version} + 1`,
          updatedAt,
        })
        .where(and(eq(journals.id, id), eq(journals.version, expectedVersion)))
        .run();
      if (result.changes === 0) throw conflict(id, expectedVersion);
      // journal_line_tags は ON DELETE CASCADE で消える
      tx.delete(journalLines).where(eq(journalLines.journalId, id)).run();
      insertLines(tx, id, journal.lines);
    });
    return this.mustGet(id);
  }

  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal {
    const result = this.db
      .update(journals)
      .set({ status: "voided", version: sql`${journals.version} + 1`, updatedAt })
      .where(and(eq(journals.id, id), eq(journals.version, expectedVersion)))
      .run();
    if (result.changes === 0) throw conflict(id, expectedVersion);
    return this.mustGet(id);
  }

  journalHistory(id: string): AuditEntry[] {
    return this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetType, "journal"), eq(auditLog.targetId, id)))
      .orderBy(rowidOf(auditLog))
      .all();
  }

  correctingJournalsOf(id: string): Journal[] {
    const rows = this.db
      .select()
      .from(journals)
      .where(eq(journals.correctsJournalId, id))
      .orderBy(asc(journals.journalNo))
      .all();
    return this.withLines(rows);
  }

  findJournals(query: JournalQuery): Page<Journal> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const conditions = searchConditions(query);
    if (query.cursor !== undefined) {
      const [date, no] = query.cursor.split("_");
      conditions.push(
        sql`(${journals.date} < ${date} or (${journals.date} = ${date} and ${journals.journalNo} < ${Number(no)}))`,
      );
    }
    const rows = this.db
      .select()
      .from(journals)
      .where(and(...conditions))
      .orderBy(desc(journals.date), desc(journals.journalNo))
      .limit(limit + 1)
      .all();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: this.withLines(page),
      nextCursor:
        rows.length > limit && last !== undefined ? `${last.date}_${last.journalNo}` : null,
    };
  }

  summarizeJournals(query: JournalQuery): JournalSummary {
    // 一致した仕訳単位で借方を合計し、行やタグの結合による重複を避ける。
    const debits = this.db
      .select({
        journalId: journalLines.journalId,
        amount: sql<number>`sum(${journalLines.amount})`.as("amount"),
      })
      .from(journalLines)
      .where(eq(journalLines.side, "debit"))
      .groupBy(journalLines.journalId)
      .as("debits");
    return (
      this.db
        .select({
          count: sql<number>`count(*)`,
          amount: sql<number>`coalesce(sum(${debits.amount}), 0)`,
        })
        .from(journals)
        .leftJoin(debits, eq(debits.journalId, journals.id))
        .where(and(...searchConditions(query)))
        .get() ?? { count: 0, amount: 0 }
    );
  }

  getJournal(id: string): Journal | undefined {
    const row = this.db.select().from(journals).where(eq(journals.id, id)).get();
    return row === undefined ? undefined : this.withLines([row])[0];
  }

  /** ids の仕訳（順は不定）。ない ID は無視する */
  getJournals(ids: readonly string[]): Journal[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .select()
      .from(journals)
      .where(inArray(journals.id, [...ids]))
      .all();
    return this.withLines(rows);
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

  recentRegistered(limit: number): Journal[] {
    const rows = this.db
      .select()
      .from(journals)
      .where(eq(journals.status, "active"))
      .orderBy(desc(journals.createdAt), desc(journals.journalNo))
      .limit(limit)
      .all();
    return this.withLines(rows);
  }

  private mustGet(id: string): Journal {
    const journal = this.getJournal(id);
    if (journal === undefined) throw new Error(`journal not found: ${id}`);
    return journal;
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
      .orderBy(rowidOf(journalLineTags))
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
        taxCategory: asTaxCategory(line.taxCategory),
        tagIds: tagsByLine.get(line.id) ?? [],
      });
      linesByJournal.set(journalId, list);
    }
    return rows.map((r) => ({ ...r, lines: linesByJournal.get(r.id) ?? [] }));
  }

  /** 有効な仕訳の行（from〜to、両端を含む）。1 本の結合クエリで読む（R12） */
  linesInRange(from: string, to: string): PostedLine[] {
    return this.db
      .select({
        journalId: journals.id,
        journalNo: journals.journalNo,
        date: journals.date,
        memo: journals.memo,
        createdAt: journals.createdAt,
        status: journals.status,
        lineNo: journalLines.lineNo,
        side: journalLines.side,
        accountId: journalLines.accountId,
        accountName: accounts.name,
        subAccountId: journalLines.subAccountId,
        subAccountName: subAccounts.name,
        amount: journalLines.amount,
        taxCategory: journalLines.taxCategory,
        taxAmount: journalLines.taxAmount,
        partnerId: journalLines.partnerId,
        partnerName: partners.name,
        description: journalLines.description,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .leftJoin(subAccounts, eq(subAccounts.id, journalLines.subAccountId))
      .leftJoin(partners, eq(partners.id, journalLines.partnerId))
      .where(and(eq(journals.status, "active"), between(journals.date, from, to)))
      .orderBy(asc(journals.date), asc(journals.journalNo), asc(journalLines.lineNo))
      .all()
      .map((row) => ({ ...row, taxCategory: asTaxCategory(row.taxCategory) }));
  }

  /** 会計年度の期首残高。年度がなければ空 */
  openingBalances(fiscalYear: number): OpeningBalance[] {
    return this.db
      .select({
        id: openingBalances.id,
        fiscalPeriodId: openingBalances.fiscalPeriodId,
        accountId: openingBalances.accountId,
        subAccountId: openingBalances.subAccountId,
        side: openingBalances.side,
        amount: openingBalances.amount,
      })
      .from(openingBalances)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, openingBalances.fiscalPeriodId))
      .where(eq(fiscalPeriods.fiscalYear, fiscalYear))
      .all();
  }
}

function insertLines(tx: TenantConn, journalId: string, lines: readonly JournalLine[]): void {
  for (const { tagIds, ...line } of lines) {
    tx.insert(journalLines)
      .values({ ...line, journalId })
      .run();
    for (const tagId of tagIds) {
      tx.insert(journalLineTags).values({ journalLineId: line.id, tagId }).run();
    }
  }
}

const conflict = (id: string, expectedVersion: number) =>
  new RepositoryConflictError(`journal ${id} is not at version ${expectedVersion}`);

/** 行の条件（いずれかの行が満たせば一致） */
const anyLine = (condition: SQL) =>
  sql`exists (select 1 from ${journalLines} where ${journalLines.journalId} = ${journals.id} and ${condition})`;

/** ページ送りと集計で共有する検索の条件（FR-023）。cursor・limit は含めない */
function searchConditions(query: JournalQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.includeVoided !== true) conditions.push(eq(journals.status, "active"));
  if (query.dateFrom !== undefined) conditions.push(sql`${journals.date} >= ${query.dateFrom}`);
  if (query.dateTo !== undefined) conditions.push(sql`${journals.date} <= ${query.dateTo}`);
  if (query.amountMin !== undefined || query.amountMax !== undefined) {
    const bounds: SQL[] = [];
    if (query.amountMin !== undefined)
      bounds.push(sql`${journalLines.amount} >= ${query.amountMin}`);
    if (query.amountMax !== undefined)
      bounds.push(sql`${journalLines.amount} <= ${query.amountMax}`);
    conditions.push(anyLine(sql.join(bounds, sql` and `)));
  }
  if (query.partnerId !== undefined) {
    conditions.push(anyLine(sql`${journalLines.partnerId} = ${query.partnerId}`));
  }
  if (query.accountId !== undefined) {
    conditions.push(anyLine(sql`${journalLines.accountId} = ${query.accountId}`));
  }
  if (query.tagId !== undefined) {
    conditions.push(
      anyLine(
        sql`exists (select 1 from ${journalLineTags} where ${journalLineTags.journalLineId} = ${journalLines.id} and ${journalLineTags.tagId} = ${query.tagId})`,
      ),
    );
  }
  const q = query.q?.trim() ?? "";
  if (q.length > 0) {
    // instr は大文字・小文字を区別する部分一致
    conditions.push(
      sql`(instr(coalesce(${journals.memo}, ''), ${q}) > 0 or ${anyLine(
        sql`instr(coalesce(${journalLines.description}, ''), ${q}) > 0`,
      )})`,
    );
  }
  return conditions;
}
