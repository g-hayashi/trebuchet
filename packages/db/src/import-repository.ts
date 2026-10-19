import type {
  AccountMapping,
  ImportBatch,
  ImportRef,
  ImportStore,
  ImportUnitOfWork,
  Journal,
  JournalSignature,
  LedgerRepository,
  MasterRepository,
  TaxCategoryCode,
  TaxMapping,
} from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import { and, asc, between, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { DrizzleLedgerRepository } from "./ledger-repository.ts";
import { DrizzleMasterRepository } from "./master-repository.ts";
import type * as tenantSchema from "./schema/tenant.ts";
import {
  importAccountMappings,
  importBatches,
  importJournalRefs,
  importTaxMappings,
  journalLines,
  journals,
} from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

type BatchRow = typeof importBatches.$inferSelect;

const insertionOrder = sql`rowid`;

function toBatch({ fiscalYearsJson, ...row }: BatchRow): ImportBatch {
  return { ...row, fiscalYears: JSON.parse(fiscalYearsJson) as number[] };
}

function toBatchRow({ fiscalYears, ...batch }: ImportBatch): BatchRow {
  return { ...batch, fiscalYearsJson: JSON.stringify(fiscalYears) };
}

function toAccountMapping(row: typeof importAccountMappings.$inferSelect): AccountMapping {
  const mapping: AccountMapping = { sourceName: row.sourceName, accountId: row.accountId };
  if (row.subAccountId !== null) mapping.subAccountId = row.subAccountId;
  if (row.subAccountName !== null) mapping.subAccountName = row.subAccountName;
  return mapping;
}

/** ImportStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期 */
export class DrizzleImportStore implements ImportStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  // ---- 対応表 ----

  listAccountMappings(): AccountMapping[] {
    return this.db
      .select()
      .from(importAccountMappings)
      .orderBy(asc(importAccountMappings.sourceName))
      .all()
      .map(toAccountMapping);
  }

  upsertAccountMappings(rows: AccountMapping[], updatedAt: string): void {
    this.db.transaction((tx) => {
      for (const row of rows) {
        const values = {
          accountId: row.accountId,
          subAccountId: row.subAccountId ?? null,
          subAccountName: row.subAccountName ?? null,
          updatedAt,
        };
        tx.insert(importAccountMappings)
          .values({ sourceName: row.sourceName, ...values })
          .onConflictDoUpdate({ target: importAccountMappings.sourceName, set: values })
          .run();
      }
    });
  }

  listTaxMappings(): TaxMapping[] {
    return this.db
      .select({
        sourceName: importTaxMappings.sourceName,
        taxCategory: importTaxMappings.taxCategory,
      })
      .from(importTaxMappings)
      .orderBy(asc(importTaxMappings.sourceName))
      .all()
      .map((row) => ({
        ...row,
        // tax_category は tax_categories への外部キーで、値は TaxCategoryCode に限られる
        taxCategory: row.taxCategory as TaxCategoryCode,
      }));
  }

  upsertTaxMappings(rows: TaxMapping[], updatedAt: string): void {
    this.db.transaction((tx) => {
      for (const row of rows) {
        tx.insert(importTaxMappings)
          .values({ ...row, updatedAt })
          .onConflictDoUpdate({
            target: importTaxMappings.sourceName,
            set: { taxCategory: row.taxCategory, updatedAt },
          })
          .run();
      }
    });
  }

  // ---- 参照 ----

  activeRefsByFreeeIds(ids: string[]): ImportRef[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(importJournalRefs)
      .where(
        and(isNull(importJournalRefs.revokedAt), inArray(importJournalRefs.freeeJournalId, ids)),
      )
      .orderBy(insertionOrder)
      .all();
  }

  activeRefsInRange(from: string, to: string): ImportRef[] {
    return this.db
      .select()
      .from(importJournalRefs)
      .where(
        and(isNull(importJournalRefs.revokedAt), between(importJournalRefs.freeeDate, from, to)),
      )
      .orderBy(insertionOrder)
      .all();
  }

  insertRefs(refs: ImportRef[]): void {
    if (refs.length === 0) return;
    this.db.transaction((tx) => {
      for (const ref of refs) tx.insert(importJournalRefs).values(ref).run();
    });
  }

  // ---- 取込の回 ----

  insertBatch(batch: ImportBatch): void {
    this.db.insert(importBatches).values(toBatchRow(batch)).run();
  }

  listBatches(): ImportBatch[] {
    return this.db
      .select()
      .from(importBatches)
      .orderBy(desc(importBatches.importedAt), desc(importBatches.id))
      .all()
      .map(toBatch);
  }

  getBatch(id: string): ImportBatch | undefined {
    const row = this.db.select().from(importBatches).where(eq(importBatches.id, id)).get();
    return row === undefined ? undefined : toBatch(row);
  }

  journalsOfBatch(id: string): { journal: Journal; ref: ImportRef }[] {
    const refs = this.db
      .select()
      .from(importJournalRefs)
      .where(eq(importJournalRefs.batchId, id))
      .all();
    const byId = new Map(
      new DrizzleLedgerRepository(this.db)
        .getJournals(refs.map((r) => r.journalId))
        .map((j) => [j.id, j]),
    );
    return refs
      .map((ref) => {
        const journal = byId.get(ref.journalId);
        if (journal === undefined) throw new Error(`journal not found: ${ref.journalId}`);
        return { journal, ref };
      })
      .sort((a, b) => a.journal.journalNo - b.journal.journalNo);
  }

  voidBatch(id: string, reason: string, at: string): void {
    this.db.transaction((tx) => {
      const result = tx
        .update(importBatches)
        .set({ status: "voided", voidedAt: at, voidReason: reason })
        .where(and(eq(importBatches.id, id), eq(importBatches.status, "active")))
        .run();
      if (result.changes === 0) throw new Error(`active import batch not found: ${id}`);
      tx.update(importJournalRefs)
        .set({ revokedAt: at })
        .where(and(eq(importJournalRefs.batchId, id), isNull(importJournalRefs.revokedAt)))
        .run();
    });
  }

  // ---- 手入力の仕訳（R16） ----

  manualJournalSignatures(from: string, to: string): JournalSignature[] {
    const rows = this.db
      .select({
        journalId: journals.id,
        journalNo: journals.journalNo,
        date: journals.date,
        side: journalLines.side,
        accountId: journalLines.accountId,
        amount: journalLines.amount,
      })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .where(
        and(
          eq(journals.source, "manual"),
          eq(journals.status, "active"),
          between(journals.date, from, to),
        ),
      )
      .orderBy(asc(journals.date), asc(journals.journalNo), asc(journalLines.lineNo))
      .all();
    const signatures = new Map<string, JournalSignature>();
    for (const { journalId, journalNo, date, side, accountId, amount } of rows) {
      const signature = signatures.get(journalId) ?? { journalId, journalNo, date, lines: [] };
      signature.lines.push({ side, accountId, amount });
      signatures.set(journalId, signature);
    }
    return [...signatures.values()];
  }
}

/**
 * ImportUnitOfWork の実装。同じ接続（のトランザクション）の上に、仕訳・マスタ・取込の記録の
 * リポジトリを作って渡す。fn が例外を投げると全体をロールバックする（research R10, INV-11）
 */
export class DrizzleImportUnitOfWork implements ImportUnitOfWork {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  transaction<T>(
    fn: (tx: { ledger: LedgerRepository; masters: MasterRepository; imports: ImportStore }) => T,
  ): T {
    return this.db.transaction((tx) =>
      fn({
        ledger: new DrizzleLedgerRepository(tx),
        masters: new DrizzleMasterRepository(tx),
        imports: new DrizzleImportStore(tx),
      }),
    );
  }
}
