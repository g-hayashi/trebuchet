import type {
  AdjustmentRef,
  ClosingAuditEntry,
  ClosingNote,
  ClosingStore,
  ClosingUnitOfWork,
  DeductionAnswers,
  DeferredAmortization,
  DeferredAsset,
  FiledDocument,
  FixedAsset,
  HomeUseAllocation,
  RentDetail,
  StraightLineRate,
  TaxParameter,
  TaxReturnMemo,
} from "@trebuchet/domain";
import { asc, eq } from "drizzle-orm";
import { insertionOrder, type TenantConn } from "./internal.ts";
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
      .all()
      .map((r) => ({
        ...r,
        // 009 の列は T005 で足す。それまでは既定値（少額の特例の意味）
        inServiceOn: null,
        priorAccumulated: 0,
        priorThroughYear: null,
        disposalKind: null,
      }));
  }

  upsertFixedAsset(row: FixedAsset): void {
    // 009 の項目（inServiceOn など）と方法の拡張は T005 で列を足してから書く（T007）
    const {
      id: _id,
      inServiceOn: _inServiceOn,
      priorAccumulated: _priorAccumulated,
      priorThroughYear: _priorThroughYear,
      disposalKind: _disposalKind,
      method,
      ...rest
    } = row;
    const columns = { ...rest, method: method as "small_asset_28_2" };
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
      .all()
      .map((r) => ({ ...r, deferredAssetId: null }));
  }

  insertAdjustmentRef(ref: AdjustmentRef): void {
    // deferredAssetId の列と kind = deferred_amortization は T005 で足す
    const { deferredAssetId: _deferredAssetId, kind, ...rest } = ref;
    this.db
      .insert(adjustmentJournalRefs)
      .values({ ...rest, kind: kind as "home_use" | "depreciation" })
      .run();
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

  // ---- 009（表は T005、実装は T007。それまでは型を通すだけの仮実装） ----

  listStraightLineRates(): StraightLineRate[] {
    throw new Error("listStraightLineRates は T007 で実装する");
  }

  listDeferredAssets(): DeferredAsset[] {
    throw new Error("listDeferredAssets は T007 で実装する");
  }

  upsertDeferredAsset(_row: DeferredAsset): void {
    throw new Error("upsertDeferredAsset は T007 で実装する");
  }

  listDeferredAmortizations(): DeferredAmortization[] {
    throw new Error("listDeferredAmortizations は T007 で実装する");
  }

  upsertDeferredAmortization(_row: DeferredAmortization): void {
    throw new Error("upsertDeferredAmortization は T007 で実装する");
  }

  listAdjustmentRefsBySource(
    _source: { assetId: string } | { deferredAssetId: string },
  ): AdjustmentRef[] {
    throw new Error("listAdjustmentRefsBySource は T007 で実装する");
  }
}

/** ClosingUnitOfWork の実装。仕訳・マスタ・決算の記録を同じトランザクションで扱う（research R4） */
export const createClosingUnitOfWork = (db: TenantConn): ClosingUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ closing: new DrizzleClosingStore(tx) }));
