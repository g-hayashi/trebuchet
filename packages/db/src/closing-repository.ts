import type {
  AdjustmentRef,
  ClosingAuditEntry,
  ClosingNote,
  ClosingStore,
  ClosingUnitOfWork,
  DeductionAnswers,
  FiledDocument,
  FixedAsset,
  HomeUseAllocation,
  RentDetail,
  TaxParameter,
  TaxReturnMemo,
} from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as tenantSchema from "./schema/tenant.ts";
import {
  adjustmentJournalRefs,
  blueDeductionAnswers,
  closingAuditLog,
  closingNotes,
  filedDocuments,
  fixedAssets,
  homeUseAllocations,
  rentDetails,
  taxParameters,
  taxReturnMemos,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/** 挿入の順（一覧の既定の順） */
const insertionOrder = sql`rowid`;

/** ClosingStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期 */
export class DrizzleClosingStore implements ClosingStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  listTaxParameters(): TaxParameter[] {
    return this.db
      .select()
      .from(taxParameters)
      .orderBy(asc(taxParameters.key), asc(taxParameters.effectiveFrom))
      .all();
  }

  // ---- 家事按分 ----

  listHomeUseAllocations(fiscalYear: number): HomeUseAllocation[] {
    return this.db
      .select()
      .from(homeUseAllocations)
      .where(eq(homeUseAllocations.fiscalYear, fiscalYear))
      .orderBy(insertionOrder)
      .all();
  }

  upsertHomeUseAllocation(row: HomeUseAllocation): void {
    const { id: _id, ...set } = row;
    this.db
      .insert(homeUseAllocations)
      .values(row)
      .onConflictDoUpdate({ target: homeUseAllocations.id, set })
      .run();
  }

  // ---- 地代家賃の内訳 ----

  listRentDetails(fiscalYear: number): RentDetail[] {
    return this.db
      .select()
      .from(rentDetails)
      .where(eq(rentDetails.fiscalYear, fiscalYear))
      .orderBy(asc(rentDetails.sortOrder), insertionOrder)
      .all();
  }

  replaceRentDetails(fiscalYear: number, rows: RentDetail[]): void {
    this.db.transaction((tx) => {
      tx.delete(rentDetails).where(eq(rentDetails.fiscalYear, fiscalYear)).run();
      for (const row of rows) tx.insert(rentDetails).values(row).run();
    });
  }

  // ---- 固定資産台帳 ----

  listFixedAssets(): FixedAsset[] {
    return this.db
      .select()
      .from(fixedAssets)
      .orderBy(asc(fixedAssets.acquiredOn), asc(fixedAssets.id))
      .all();
  }

  upsertFixedAsset(row: FixedAsset): void {
    const { id: _id, ...set } = row;
    this.db
      .insert(fixedAssets)
      .values(row)
      .onConflictDoUpdate({ target: fixedAssets.id, set })
      .run();
  }

  // ---- 決算整理の仕訳の出所 ----

  listAdjustmentRefs(fiscalYear: number): AdjustmentRef[] {
    return this.db
      .select()
      .from(adjustmentJournalRefs)
      .where(eq(adjustmentJournalRefs.fiscalYear, fiscalYear))
      .orderBy(insertionOrder)
      .all();
  }

  insertAdjustmentRef(ref: AdjustmentRef): void {
    this.db.insert(adjustmentJournalRefs).values(ref).run();
  }

  // ---- 控除の要件の回答 ----

  getDeductionAnswers(fiscalYear: number): DeductionAnswers | undefined {
    return this.db
      .select()
      .from(blueDeductionAnswers)
      .where(eq(blueDeductionAnswers.fiscalYear, fiscalYear))
      .get();
  }

  upsertDeductionAnswers(row: DeductionAnswers): void {
    const { fiscalYear: _fiscalYear, ...set } = row;
    this.db
      .insert(blueDeductionAnswers)
      .values(row)
      .onConflictDoUpdate({ target: blueDeductionAnswers.fiscalYear, set })
      .run();
  }

  // ---- 決算のメモ ----

  listClosingNotes(fiscalYear: number): ClosingNote[] {
    return this.db
      .select()
      .from(closingNotes)
      .where(eq(closingNotes.fiscalYear, fiscalYear))
      .orderBy(asc(closingNotes.kind))
      .all();
  }

  upsertClosingNote(row: ClosingNote): void {
    this.db
      .insert(closingNotes)
      .values(row)
      .onConflictDoUpdate({
        target: [closingNotes.fiscalYear, closingNotes.kind],
        set: { body: row.body, updatedAt: row.updatedAt },
      })
      .run();
  }

  // ---- 事業所得以外の控え ----

  listTaxReturnMemos(fiscalYear: number): TaxReturnMemo[] {
    return this.db
      .select()
      .from(taxReturnMemos)
      .where(eq(taxReturnMemos.fiscalYear, fiscalYear))
      .orderBy(insertionOrder)
      .all();
  }

  upsertTaxReturnMemo(row: TaxReturnMemo): void {
    const { id: _id, ...set } = row;
    this.db
      .insert(taxReturnMemos)
      .values(row)
      .onConflictDoUpdate({ target: taxReturnMemos.id, set })
      .run();
  }

  deleteTaxReturnMemo(id: string): void {
    this.db.delete(taxReturnMemos).where(eq(taxReturnMemos.id, id)).run();
  }

  // ---- 提出書類の記録 ----

  listFiledDocuments(fiscalYear: number): FiledDocument[] {
    return this.db
      .select()
      .from(filedDocuments)
      .where(eq(filedDocuments.fiscalYear, fiscalYear))
      .orderBy(insertionOrder)
      .all();
  }

  upsertFiledDocument(row: FiledDocument): void {
    const { id: _id, ...set } = row;
    this.db
      .insert(filedDocuments)
      .values(row)
      .onConflictDoUpdate({ target: filedDocuments.id, set })
      .run();
  }

  deleteFiledDocument(id: string): void {
    this.db.delete(filedDocuments).where(eq(filedDocuments.id, id)).run();
  }

  // ---- 変更履歴 ----

  appendClosingAudit(entry: ClosingAuditEntry): void {
    this.db.insert(closingAuditLog).values(entry).run();
  }
}

/** ClosingUnitOfWork の実装。仕訳・マスタ・決算の記録を同じトランザクションで扱う（research R4） */
export const createClosingUnitOfWork = (db: TenantConn): ClosingUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ closing: new DrizzleClosingStore(tx) }));
