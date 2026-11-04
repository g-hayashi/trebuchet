import type {
  AdjustmentRef,
  ClosingAuditEntry,
  ClosingNote,
  ClosingStore,
  ClosingUnitOfWork,
  DeductionAnswers,
  DeferredAmortization,
  DeferredAsset,
  FixedAsset,
  HomeUseAllocation,
  RentDetail,
  StraightLineRate,
  TaxParameter,
} from "@trebuchet/domain";
import { asc, eq } from "drizzle-orm";
import { insertionOrder, type TenantConn } from "./internal.ts";
import {
  adjustmentJournalRefs,
  blueDeductionAnswers,
  closingAuditLog,
  closingNotes,
  deferredAmortizations,
  deferredAssets,
  fixedAssets,
  homeUseAllocations,
  rentDetails,
  straightLineRates,
  taxParameters,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

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
    const { id: _id, ...columns } = row;
    this.db
      .insert(fixedAssets)
      .values({ id: row.id, ...columns })
      .onConflictDoUpdate({ target: fixedAssets.id, set: columns })
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

  /** 出所ごとの参照（全年度）。登録の順 */
  listAdjustmentRefsBySource(
    source: { assetId: string } | { deferredAssetId: string },
  ): AdjustmentRef[] {
    const where =
      "assetId" in source
        ? eq(adjustmentJournalRefs.assetId, source.assetId)
        : eq(adjustmentJournalRefs.deferredAssetId, source.deferredAssetId);
    return this.db.select().from(adjustmentJournalRefs).where(where).orderBy(insertionOrder).all();
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

  // ---- 変更履歴 ----

  appendClosingAudit(entry: ClosingAuditEntry): void {
    this.db.insert(closingAuditLog).values(entry).run();
  }

  // ---- 009: 定額法の償却率・開業費 ----

  listStraightLineRates(): StraightLineRate[] {
    return this.db
      .select()
      .from(straightLineRates)
      .orderBy(asc(straightLineRates.usefulLifeYears), asc(straightLineRates.effectiveFrom))
      .all();
  }

  listDeferredAssets(): DeferredAsset[] {
    return this.db
      .select()
      .from(deferredAssets)
      .orderBy(asc(deferredAssets.openedOn), asc(deferredAssets.id))
      .all();
  }

  upsertDeferredAsset(row: DeferredAsset): void {
    const { id: _id, ...set } = row;
    this.db
      .insert(deferredAssets)
      .values(row)
      .onConflictDoUpdate({ target: deferredAssets.id, set })
      .run();
  }

  /** 全年度（開業費の期首の残高は前の年度の決定から求める） */
  listDeferredAmortizations(): DeferredAmortization[] {
    return this.db
      .select()
      .from(deferredAmortizations)
      .orderBy(asc(deferredAmortizations.deferredAssetId), asc(deferredAmortizations.fiscalYear))
      .all();
  }

  upsertDeferredAmortization(row: DeferredAmortization): void {
    const { deferredAssetId: _assetId, fiscalYear: _fiscalYear, ...set } = row;
    this.db
      .insert(deferredAmortizations)
      .values(row)
      .onConflictDoUpdate({
        target: [deferredAmortizations.deferredAssetId, deferredAmortizations.fiscalYear],
        set,
      })
      .run();
  }
}

/** ClosingUnitOfWork の実装。仕訳・マスタ・決算の記録を同じトランザクションで扱う（research R4） */
export const createClosingUnitOfWork = (db: TenantConn): ClosingUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ closing: new DrizzleClosingStore(tx) }));
