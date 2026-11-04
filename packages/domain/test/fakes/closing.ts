import type { ClosingStore } from "../../src/ports.ts";
import type {
  AdjustmentRef,
  ClosingAuditEntry,
  ClosingNote,
  DeductionAnswers,
  DeferredAmortization,
  DeferredAsset,
  FixedAsset,
  HomeUseAllocation,
  RentDetail,
  StraightLineRate,
  TaxParameter,
} from "../../src/types.ts";
import { InMemoryLedgerRepository } from "./ledger.ts";
import { InMemoryMasterRepository } from "./master.ts";
import { fakeUnitOfWork } from "./unit-of-work.ts";

type ClosingState = {
  taxParameters: TaxParameter[];
  straightLineRates: StraightLineRate[];
  homeUseAllocations: HomeUseAllocation[];
  rentDetails: RentDetail[];
  fixedAssets: FixedAsset[];
  deferredAssets: DeferredAsset[];
  deferredAmortizations: DeferredAmortization[];
  adjustmentRefs: AdjustmentRef[];
  deductionAnswers: DeductionAnswers[];
  closingNotes: ClosingNote[];
  audits: ClosingAuditEntry[];
};

const emptyClosingState = (): ClosingState => ({
  taxParameters: [],
  straightLineRates: [],
  homeUseAllocations: [],
  rentDetails: [],
  fixedAssets: [],
  deferredAssets: [],
  deferredAmortizations: [],
  adjustmentRefs: [],
  deductionAnswers: [],
  closingNotes: [],
  audits: [],
});

/** id で置き換える（なければ追加する） */
function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  return [...rows.filter((r) => r.id !== row.id), structuredClone(row)];
}

/**
 * ClosingStore のフェイク。仕訳は InMemoryLedgerRepository から読む。
 * DB の制約（参照先の仕訳の存在、参照の仕訳 ID の一意、按分の登録の一意）も確かめる
 */
export class InMemoryClosingStore implements ClosingStore {
  state: ClosingState = emptyClosingState();
  private readonly ledger: InMemoryLedgerRepository;

  constructor(ledger: InMemoryLedgerRepository) {
    this.ledger = ledger;
  }

  get audits(): ClosingAuditEntry[] {
    return this.state.audits;
  }
  /** テストが税制の値を差し込む */
  set taxParameters(rows: TaxParameter[]) {
    this.state.taxParameters = structuredClone(rows);
  }
  /** テストが定額法の償却率の表を差し込む */
  set straightLineRates(rows: StraightLineRate[]) {
    this.state.straightLineRates = structuredClone(rows);
  }

  listTaxParameters(): TaxParameter[] {
    return structuredClone(this.state.taxParameters);
  }

  listHomeUseAllocations(fiscalYear: number): HomeUseAllocation[] {
    return structuredClone(
      this.state.homeUseAllocations.filter((a) => a.fiscalYear === fiscalYear),
    );
  }
  upsertHomeUseAllocation(row: HomeUseAllocation): void {
    const clash = this.state.homeUseAllocations.some(
      (a) =>
        a.id !== row.id &&
        a.fiscalYear === row.fiscalYear &&
        a.accountId === row.accountId &&
        a.subAccountId === row.subAccountId,
    );
    if (clash) throw new Error("UNIQUE constraint failed: home_use_allocations");
    this.state.homeUseAllocations = upsertById(this.state.homeUseAllocations, row);
  }

  listRentDetails(fiscalYear: number): RentDetail[] {
    return structuredClone(
      this.state.rentDetails
        .filter((r) => r.fiscalYear === fiscalYear)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    );
  }
  replaceRentDetails(fiscalYear: number, rows: RentDetail[]): void {
    this.state.rentDetails = [
      ...this.state.rentDetails.filter((r) => r.fiscalYear !== fiscalYear),
      ...structuredClone(rows),
    ];
  }

  listFixedAssets(): FixedAsset[] {
    return structuredClone(
      [...this.state.fixedAssets].sort(
        (a, b) => a.acquiredOn.localeCompare(b.acquiredOn) || a.id.localeCompare(b.id),
      ),
    );
  }
  upsertFixedAsset(row: FixedAsset): void {
    this.state.fixedAssets = upsertById(this.state.fixedAssets, row);
  }

  listAdjustmentRefs(fiscalYear: number): AdjustmentRef[] {
    return structuredClone(this.state.adjustmentRefs.filter((r) => r.fiscalYear === fiscalYear));
  }
  insertAdjustmentRef(ref: AdjustmentRef): void {
    if (!this.ledger.journals.some((j) => j.id === ref.journalId)) {
      throw new Error("FOREIGN KEY constraint failed: adjustment_journal_refs.journal_id");
    }
    if (this.state.adjustmentRefs.some((r) => r.journalId === ref.journalId)) {
      throw new Error("UNIQUE constraint failed: adjustment_journal_refs.journal_id");
    }
    this.state.adjustmentRefs.push({ ...ref });
  }

  getDeductionAnswers(fiscalYear: number): DeductionAnswers | undefined {
    const found = this.state.deductionAnswers.find((a) => a.fiscalYear === fiscalYear);
    return found === undefined ? undefined : { ...found };
  }
  upsertDeductionAnswers(row: DeductionAnswers): void {
    this.state.deductionAnswers = [
      ...this.state.deductionAnswers.filter((a) => a.fiscalYear !== row.fiscalYear),
      { ...row },
    ];
  }

  listClosingNotes(fiscalYear: number): ClosingNote[] {
    return structuredClone(this.state.closingNotes.filter((n) => n.fiscalYear === fiscalYear));
  }
  upsertClosingNote(row: ClosingNote): void {
    this.state.closingNotes = [
      ...this.state.closingNotes.filter(
        (n) => !(n.fiscalYear === row.fiscalYear && n.kind === row.kind),
      ),
      { ...row },
    ];
  }

  appendClosingAudit(entry: ClosingAuditEntry): void {
    this.state.audits.push({ ...entry });
  }

  // ---- 009 ----

  listStraightLineRates(): StraightLineRate[] {
    return structuredClone(
      [...this.state.straightLineRates].sort(
        (a, b) =>
          a.usefulLifeYears - b.usefulLifeYears || a.effectiveFrom.localeCompare(b.effectiveFrom),
      ),
    );
  }

  listDeferredAssets(): DeferredAsset[] {
    return structuredClone(
      [...this.state.deferredAssets].sort(
        (a, b) => a.openedOn.localeCompare(b.openedOn) || a.id.localeCompare(b.id),
      ),
    );
  }
  upsertDeferredAsset(row: DeferredAsset): void {
    this.state.deferredAssets = upsertById(this.state.deferredAssets, row);
  }

  listDeferredAmortizations(): DeferredAmortization[] {
    return structuredClone(
      [...this.state.deferredAmortizations].sort(
        (a, b) => a.deferredAssetId.localeCompare(b.deferredAssetId) || a.fiscalYear - b.fiscalYear,
      ),
    );
  }
  upsertDeferredAmortization(row: DeferredAmortization): void {
    this.state.deferredAmortizations = [
      ...this.state.deferredAmortizations.filter(
        (d) => !(d.deferredAssetId === row.deferredAssetId && d.fiscalYear === row.fiscalYear),
      ),
      { ...row },
    ];
  }

  listAdjustmentRefsBySource(
    source: { assetId: string } | { deferredAssetId: string },
  ): AdjustmentRef[] {
    return structuredClone(
      this.state.adjustmentRefs.filter((r) =>
        "assetId" in source
          ? r.assetId === source.assetId
          : r.deferredAssetId === source.deferredAssetId,
      ),
    );
  }
}

/** ClosingUnitOfWork のフェイク（research R4） */
export const fakeClosingUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  closing = new InMemoryClosingStore(ledger),
) => fakeUnitOfWork(ledger, masters, { closing });
export type FakeClosingUnitOfWork = ReturnType<typeof fakeClosingUnitOfWork>;
