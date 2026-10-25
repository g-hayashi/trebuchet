import type { BillingTerms, InvoiceSettings, JournalOrigin, Recurring } from "@trebuchet/schema";
import { isSessionActive } from "../src/auth/session.ts";
import type {
  AppSettingKey,
  AuthEvent,
  AuthEventKind,
  BackupRun,
  NewAuthEvent,
  NewBackupRun,
  NewPasskey,
  NewSession,
  Passkey,
  Session,
} from "../src/auth/types.ts";
import type {
  AccountMapping,
  ImportBatch,
  ImportRef,
  JournalSignature,
  TaxMapping,
} from "../src/import/types.ts";
import {
  type AuthStore,
  type BackupStore,
  type Clock,
  type ClosingStore,
  type IdGenerator,
  type ImportStore,
  type InvoicingStore,
  type JournalReplacement,
  type LedgerRepository,
  type MasterRepository,
  type NewJournal,
  type RecurringStore,
  type RegistryRepository,
  RepositoryConflictError,
  type SecretStore,
  type TenantTx,
  type TenantUnitOfWork,
} from "../src/ports.ts";
import type {
  Account,
  AdjustmentRef,
  AuditEntry,
  ClosingAuditEntry,
  ClosingNote,
  DeductionAnswers,
  EntityProfile,
  EntitySummary,
  FiledDocument,
  FiscalPeriod,
  FixedAsset,
  HomeUseAllocation,
  InvoiceItemRecord,
  InvoiceRecord,
  InvoicingAuditEntry,
  Journal,
  JournalQuery,
  OpeningBalance,
  Page,
  Partner,
  PaymentRecord,
  RecurringRunRecord,
  RentDetail,
  Result,
  SubAccount,
  Tag,
  TaxCategory,
  TaxParameter,
  TaxRate,
  TaxReturnMemo,
  TaxSetting,
  WorkHoursRow,
} from "../src/types.ts";

/** ユースケースのテスト用のフェイク（メモリ上の実装） */

/** UUID の形式の連番を返す */
export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }
}

export class FixedClock implements Clock {
  value: string;
  constructor(value = "2026-10-18T00:00:00.000Z") {
    this.value = value;
  }
  now(): string {
    return this.value;
  }
}

export class InMemoryRegistry implements RegistryRepository {
  entities: EntitySummary[] = [];
  failOnInsert = false;

  listEntities(): EntitySummary[] {
    return [...this.entities];
  }
  getEntity(id: string): EntitySummary | undefined {
    return this.entities.find((e) => e.id === id);
  }
  insertEntity(entity: EntitySummary): void {
    if (this.failOnInsert) throw new Error("registry insert failed");
    this.entities.push(entity);
  }
  renameEntity(id: string, name: string): void {
    this.entities = this.entities.map((e) => (e.id === id ? { ...e, name } : e));
  }
}

type MasterState = {
  profile: EntityProfile | undefined;
  accounts: Account[];
  subAccounts: SubAccount[];
  partners: Partner[];
  tags: Tag[];
  taxCategories: TaxCategory[];
  taxRates: TaxRate[];
  taxSettings: TaxSetting[];
  periods: FiscalPeriod[];
  openingBalances: OpeningBalance[];
  audits: AuditEntry[];
};

const emptyState = (): MasterState => ({
  profile: undefined,
  accounts: [],
  subAccounts: [],
  partners: [],
  tags: [],
  taxCategories: [],
  taxRates: [],
  taxSettings: [],
  periods: [],
  openingBalances: [],
  audits: [],
});

/**
 * MasterRepository のフェイク。transaction は err か例外のときに状態を巻き戻す。
 * 仕訳で使われた科目は usedAccountIds で表す。
 */
export class InMemoryMasterRepository implements MasterRepository {
  state: MasterState = emptyState();
  usedAccountIds = new Set<string>();
  /** 指定した回数目の insertAccount で例外を投げる（ロールバックの確認用） */
  failOnInsertAccountAt: number | undefined;
  private insertAccountCount = 0;

  get audits(): AuditEntry[] {
    return this.state.audits;
  }

  transaction<T>(fn: (tx: MasterRepository) => Result<T>): Result<T> {
    const snapshot = structuredClone(this.state);
    try {
      const result = fn(this);
      if (!result.ok) this.state = snapshot;
      return result;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  appendAudit(entry: AuditEntry): void {
    this.state.audits.push(entry);
  }

  getProfile(): EntityProfile | undefined {
    return this.state.profile;
  }
  saveProfile(profile: EntityProfile): void {
    this.state.profile = profile;
  }

  listAccounts(): Account[] {
    return [...this.state.accounts].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
    );
  }
  getAccount(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }
  insertAccount(account: Account): void {
    this.insertAccountCount += 1;
    if (this.insertAccountCount === this.failOnInsertAccountAt) {
      throw new Error("insertAccount failed");
    }
    if (this.state.accounts.some((a) => a.code === account.code || a.name === account.name)) {
      throw new Error("UNIQUE constraint failed: accounts");
    }
    this.state.accounts.push(account);
  }
  updateAccount(account: Account): void {
    this.state.accounts = this.state.accounts.map((a) => (a.id === account.id ? account : a));
  }
  deleteAccount(id: string): void {
    this.state.subAccounts = this.state.subAccounts.filter((s) => s.accountId !== id);
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
  }
  isAccountUsed(accountId: string): boolean {
    return (
      this.usedAccountIds.has(accountId) ||
      this.state.openingBalances.some((o) => o.accountId === accountId)
    );
  }

  listSubAccounts(accountId?: string): SubAccount[] {
    return this.state.subAccounts.filter(
      (s) => accountId === undefined || s.accountId === accountId,
    );
  }
  insertSubAccount(subAccount: SubAccount): void {
    this.state.subAccounts.push(subAccount);
  }

  listPartners(): Partner[] {
    return [...this.state.partners];
  }
  insertPartner(partner: Partner): void {
    this.state.partners.push(partner);
  }
  updatePartner(partner: Partner): void {
    this.state.partners = this.state.partners.map((p) => (p.id === partner.id ? partner : p));
  }

  listTags(): Tag[] {
    return [...this.state.tags];
  }
  insertTag(tag: Tag): void {
    this.state.tags.push(tag);
  }

  listTaxCategories(): TaxCategory[] {
    return [...this.state.taxCategories];
  }
  listTaxRates(): TaxRate[] {
    return [...this.state.taxRates];
  }
  listTaxSettings(): TaxSetting[] {
    return [...this.state.taxSettings].sort((a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom),
    );
  }
  replaceTaxSettings(settings: TaxSetting[]): void {
    this.state.taxSettings = [...settings];
  }

  listFiscalPeriods(): FiscalPeriod[] {
    return [...this.state.periods].sort((a, b) => a.fiscalYear - b.fiscalYear);
  }
  getFiscalPeriodByYear(fiscalYear: number): FiscalPeriod | undefined {
    return this.state.periods.find((p) => p.fiscalYear === fiscalYear);
  }
  insertFiscalPeriod(period: FiscalPeriod): void {
    this.state.periods.push(period);
  }
  updateFiscalPeriod(period: FiscalPeriod): void {
    this.state.periods = this.state.periods.map((p) => (p.id === period.id ? period : p));
  }
  fiscalPeriodHistory(): AuditEntry[] {
    return this.state.audits.filter((a) => a.targetType === "fiscal_period");
  }

  listOpeningBalances(fiscalPeriodId: string): OpeningBalance[] {
    return this.state.openingBalances.filter((o) => o.fiscalPeriodId === fiscalPeriodId);
  }
  replaceOpeningBalances(fiscalPeriodId: string, rows: OpeningBalance[]): void {
    this.state.openingBalances = [
      ...this.state.openingBalances.filter((o) => o.fiscalPeriodId !== fiscalPeriodId),
      ...rows,
    ];
  }
}

/** LedgerRepository のフェイク。transaction は err か例外のときに状態を巻き戻す */
export class InMemoryLedgerRepository implements LedgerRepository {
  state: { journals: Journal[]; audits: AuditEntry[] } = { journals: [], audits: [] };
  /** true なら appendAudit で例外を投げる（ロールバックの確認用） */
  failOnAppendAudit = false;

  get journals(): Journal[] {
    return this.state.journals;
  }
  get audits(): AuditEntry[] {
    return this.state.audits;
  }

  transaction<T>(fn: (tx: LedgerRepository) => Result<T>): Result<T> {
    const snapshot = structuredClone(this.state);
    try {
      const result = fn(this);
      if (!result.ok) this.state = snapshot;
      return result;
    } catch (e) {
      this.state = snapshot;
      throw e;
    }
  }

  appendAudit(entry: AuditEntry): void {
    if (this.failOnAppendAudit) throw new Error("appendAudit failed");
    this.state.audits.push(entry);
  }

  nextJournalNo(): number {
    return Math.max(0, ...this.state.journals.map((j) => j.journalNo)) + 1;
  }

  lastJournal(): Journal | undefined {
    return this.state.journals.reduce<Journal | undefined>(
      (last, j) => (last === undefined || j.journalNo > last.journalNo ? j : last),
      undefined,
    );
  }

  insertJournal(journal: NewJournal): Journal {
    if (this.state.journals.some((j) => j.journalNo === journal.journalNo)) {
      throw new Error("UNIQUE constraint failed: journals.journal_no");
    }
    const saved: Journal = {
      ...journal,
      status: "active",
      source: journal.source ?? "manual",
      version: 1,
      updatedAt: journal.createdAt,
    };
    this.state.journals.push(structuredClone(saved));
    return saved;
  }

  getJournal(id: string): Journal | undefined {
    const found = this.state.journals.find((j) => j.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  recentJournals(limit: number): Journal[] {
    return [...this.state.journals]
      .sort((a, b) => b.date.localeCompare(a.date) || b.journalNo - a.journalNo)
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }

  replaceJournal(
    id: string,
    journal: JournalReplacement,
    expectedVersion: number,
    updatedAt: string,
  ): Journal {
    const current = this.lockForUpdate(id, expectedVersion);
    const saved: Journal = {
      ...current,
      ...structuredClone(journal),
      version: current.version + 1,
      updatedAt,
    };
    this.state.journals = this.state.journals.map((j) => (j.id === id ? saved : j));
    return structuredClone(saved);
  }

  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal {
    const current = this.lockForUpdate(id, expectedVersion);
    const saved: Journal = {
      ...current,
      status: "voided",
      version: current.version + 1,
      updatedAt,
    };
    this.state.journals = this.state.journals.map((j) => (j.id === id ? saved : j));
    return structuredClone(saved);
  }

  journalHistory(id: string): AuditEntry[] {
    return this.state.audits.filter((a) => a.targetType === "journal" && a.targetId === id);
  }

  correctingJournalsOf(id: string): Journal[] {
    return this.state.journals
      .filter((j) => j.correctsJournalId === id)
      .sort((a, b) => a.journalNo - b.journalNo)
      .map((j) => structuredClone(j));
  }

  findJournals(_query: JournalQuery): Page<Journal> {
    throw new Error("検索はフェイクでは扱わない（packages/db のテストで確認する）");
  }

  private lockForUpdate(id: string, expectedVersion: number): Journal {
    const current = this.state.journals.find((j) => j.id === id);
    if (current === undefined) throw new Error(`journal not found: ${id}`);
    if (current.version !== expectedVersion) {
      throw new RepositoryConflictError("仕訳は他の操作で変更されています");
    }
    return current;
  }
}

type ImportState = {
  accountMappings: (AccountMapping & { updatedAt: string })[];
  taxMappings: (TaxMapping & { updatedAt: string })[];
  batches: ImportBatch[];
  refs: ImportRef[];
};

const bySourceName = (a: { sourceName: string }, b: { sourceName: string }) =>
  a.sourceName < b.sourceName ? -1 : a.sourceName > b.sourceName ? 1 : 0;

const stripUpdatedAt = <T extends { updatedAt: string }>({ updatedAt: _, ...row }: T) => row;

/**
 * ImportStore のフェイク。仕訳は InMemoryLedgerRepository から読む。
 * DB の制約（取り消されていない参照の freee の仕訳ID の一意、参照先の仕訳・取込の回の存在）も確かめる
 */
export class InMemoryImportStore implements ImportStore {
  state: ImportState = { accountMappings: [], taxMappings: [], batches: [], refs: [] };
  /** true なら insertBatch で例外を投げる（ロールバックの確認用） */
  failOnInsertBatch = false;
  private readonly ledger: InMemoryLedgerRepository;

  constructor(ledger: InMemoryLedgerRepository) {
    this.ledger = ledger;
  }

  get batches(): ImportBatch[] {
    return this.state.batches;
  }
  get refs(): ImportRef[] {
    return this.state.refs;
  }

  listAccountMappings(): AccountMapping[] {
    return this.state.accountMappings.map(stripUpdatedAt).sort(bySourceName);
  }
  upsertAccountMappings(rows: AccountMapping[], updatedAt: string): void {
    for (const row of rows) {
      if (row.subAccountId !== undefined && row.subAccountName !== undefined) {
        throw new Error("CHECK constraint failed: import_account_mappings_sub_account");
      }
      const others = this.state.accountMappings.filter((m) => m.sourceName !== row.sourceName);
      this.state.accountMappings = [...others, { ...structuredClone(row), updatedAt }];
    }
  }

  listTaxMappings(): TaxMapping[] {
    return this.state.taxMappings.map(stripUpdatedAt).sort(bySourceName);
  }
  upsertTaxMappings(rows: TaxMapping[], updatedAt: string): void {
    for (const row of rows) {
      const others = this.state.taxMappings.filter((m) => m.sourceName !== row.sourceName);
      this.state.taxMappings = [...others, { ...row, updatedAt }];
    }
  }

  activeRefsByFreeeIds(ids: string[]): ImportRef[] {
    const wanted = new Set(ids);
    return this.state.refs
      .filter((r) => r.revokedAt === null && wanted.has(r.freeeJournalId))
      .map((r) => ({ ...r }));
  }
  activeRefsInRange(from: string, to: string): ImportRef[] {
    return this.state.refs
      .filter((r) => r.revokedAt === null && r.freeeDate >= from && r.freeeDate <= to)
      .map((r) => ({ ...r }));
  }

  insertBatch(batch: ImportBatch): void {
    if (this.failOnInsertBatch) throw new Error("insertBatch failed");
    if (this.state.batches.some((b) => b.id === batch.id)) {
      throw new Error("UNIQUE constraint failed: import_batches.id");
    }
    this.state.batches.push(structuredClone(batch));
  }

  insertRefs(refs: ImportRef[]): void {
    for (const ref of refs) {
      if (!this.ledger.journals.some((j) => j.id === ref.journalId)) {
        throw new Error("FOREIGN KEY constraint failed: import_journal_refs.journal_id");
      }
      if (!this.state.batches.some((b) => b.id === ref.batchId)) {
        throw new Error("FOREIGN KEY constraint failed: import_journal_refs.batch_id");
      }
      if (this.state.refs.some((r) => r.journalId === ref.journalId)) {
        throw new Error("UNIQUE constraint failed: import_journal_refs.journal_id");
      }
      if (
        this.state.refs.some((r) => r.revokedAt === null && r.freeeJournalId === ref.freeeJournalId)
      ) {
        throw new Error("UNIQUE constraint failed: import_journal_refs.freee_journal_id");
      }
      this.state.refs.push({ ...ref });
    }
  }

  listBatches(): ImportBatch[] {
    return [...this.state.batches]
      .sort(
        (a, b) =>
          b.importedAt.localeCompare(a.importedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((b) => structuredClone(b));
  }
  getBatch(id: string): ImportBatch | undefined {
    const found = this.state.batches.find((b) => b.id === id);
    return found === undefined ? undefined : structuredClone(found);
  }

  journalsOfBatch(id: string): { journal: Journal; ref: ImportRef }[] {
    return this.state.refs
      .filter((r) => r.batchId === id)
      .map((ref) => {
        const journal = this.ledger.getJournal(ref.journalId);
        if (journal === undefined) throw new Error(`journal not found: ${ref.journalId}`);
        return { journal, ref: { ...ref } };
      })
      .sort((a, b) => a.journal.journalNo - b.journal.journalNo);
  }

  voidBatch(id: string, reason: string, at: string): void {
    const batch = this.state.batches.find((b) => b.id === id);
    if (batch === undefined || batch.status !== "active") {
      throw new Error(`active import batch not found: ${id}`);
    }
    this.state.batches = this.state.batches.map((b) =>
      b.id === id ? { ...b, status: "voided", voidedAt: at, voidReason: reason } : b,
    );
    this.state.refs = this.state.refs.map((r) =>
      r.batchId === id && r.revokedAt === null ? { ...r, revokedAt: at } : r,
    );
  }

  manualJournalSignatures(from: string, to: string): JournalSignature[] {
    return this.ledger.journals
      .filter(
        (j) => j.source === "manual" && j.status === "active" && j.date >= from && j.date <= to,
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.journalNo - b.journalNo)
      .map((j) => ({
        journalId: j.id,
        journalNo: j.journalNo,
        date: j.date,
        lines: j.lines.map(({ side, accountId, amount }) => ({ side, accountId, amount })),
      }));
  }
}

/** 状態を `state` に持つフェイクのストア（UnitOfWork が複製して巻き戻す） */
type Stateful = { state: unknown };

/**
 * TenantUnitOfWork のフェイク（db の `drizzleUnitOfWork` と同じ性質）。`run` の前に帳簿・マスタ・
 * ストアの状態を複製し、fn が `err` を返すか例外を投げると、すべてを元に戻す。
 * 同じ UnitOfWork の `run` の中の `run` は例外（db では入れ子のトランザクションにならないため）
 */
export class FakeUnitOfWork<Stores extends Record<string, Stateful>>
  implements TenantUnitOfWork<Stores>
{
  readonly ledger: InMemoryLedgerRepository;
  readonly masters: InMemoryMasterRepository;
  readonly stores: Stores;
  private running = false;

  constructor(ledger: InMemoryLedgerRepository, masters: InMemoryMasterRepository, stores: Stores) {
    this.ledger = ledger;
    this.masters = masters;
    this.stores = stores;
  }

  run<T>(fn: (tx: TenantTx<Stores>) => Result<T>): Result<T> {
    if (this.running) throw new Error("UnitOfWork の run は入れ子にできません");
    const targets: Stateful[] = [this.ledger, this.masters, ...Object.values(this.stores)];
    const snapshot = targets.map((t) => structuredClone(t.state));
    const restore = () => {
      targets.forEach((t, i) => {
        t.state = snapshot[i];
      });
    };
    this.running = true;
    try {
      const result = fn({ ledger: this.ledger, masters: this.masters, ...this.stores });
      if (!result.ok) restore();
      return result;
    } catch (e) {
      restore();
      throw e;
    } finally {
      this.running = false;
    }
  }
}

/** FakeUnitOfWork に、ストアを名前のままのプロパティとして足したもの（`uow.invoicing` など） */
export type FakeUnitOfWorkOf<Stores extends Record<string, Stateful>> = FakeUnitOfWork<Stores> &
  Stores;

export function fakeUnitOfWork<Stores extends Record<string, Stateful>>(
  ledger: InMemoryLedgerRepository,
  masters: InMemoryMasterRepository,
  stores: Stores,
): FakeUnitOfWorkOf<Stores> {
  return Object.assign(new FakeUnitOfWork(ledger, masters, stores), stores);
}

/** ImportUnitOfWork のフェイク（INV-11） */
export const fakeImportUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  imports = new InMemoryImportStore(ledger),
) => fakeUnitOfWork(ledger, masters, { imports });
export type FakeImportUnitOfWork = ReturnType<typeof fakeImportUnitOfWork>;

type ClosingState = {
  taxParameters: TaxParameter[];
  homeUseAllocations: HomeUseAllocation[];
  rentDetails: RentDetail[];
  fixedAssets: FixedAsset[];
  adjustmentRefs: AdjustmentRef[];
  deductionAnswers: DeductionAnswers[];
  closingNotes: ClosingNote[];
  taxReturnMemos: TaxReturnMemo[];
  filedDocuments: FiledDocument[];
  audits: ClosingAuditEntry[];
};

const emptyClosingState = (): ClosingState => ({
  taxParameters: [],
  homeUseAllocations: [],
  rentDetails: [],
  fixedAssets: [],
  adjustmentRefs: [],
  deductionAnswers: [],
  closingNotes: [],
  taxReturnMemos: [],
  filedDocuments: [],
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

  listTaxReturnMemos(fiscalYear: number): TaxReturnMemo[] {
    return structuredClone(this.state.taxReturnMemos.filter((m) => m.fiscalYear === fiscalYear));
  }
  upsertTaxReturnMemo(row: TaxReturnMemo): void {
    this.state.taxReturnMemos = upsertById(this.state.taxReturnMemos, row);
  }
  deleteTaxReturnMemo(id: string): void {
    this.state.taxReturnMemos = this.state.taxReturnMemos.filter((m) => m.id !== id);
  }

  listFiledDocuments(fiscalYear: number): FiledDocument[] {
    return structuredClone(this.state.filedDocuments.filter((d) => d.fiscalYear === fiscalYear));
  }
  upsertFiledDocument(row: FiledDocument): void {
    this.state.filedDocuments = upsertById(this.state.filedDocuments, row);
  }
  deleteFiledDocument(id: string): void {
    this.state.filedDocuments = this.state.filedDocuments.filter((d) => d.id !== id);
  }

  appendClosingAudit(entry: ClosingAuditEntry): void {
    this.state.audits.push({ ...entry });
  }
}

/** ClosingUnitOfWork のフェイク（research R4） */
export const fakeClosingUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  closing = new InMemoryClosingStore(ledger),
) => fakeUnitOfWork(ledger, masters, { closing });
export type FakeClosingUnitOfWork = ReturnType<typeof fakeClosingUnitOfWork>;

type InvoicingState = {
  origins: Record<string, JournalOrigin>;
  audits: InvoicingAuditEntry[];
  settings: InvoiceSettings | null;
  billingTerms: BillingTerms[];
  workHours: WorkHoursRow[];
  invoices: InvoiceRecord[];
  items: InvoiceItemRecord[];
  /** 消し込み。書き込みは US2（T017）で足すので、それまではテストが直接入れる */
  payments: PaymentRecord[];
};

/**
 * InvoicingStore のフェイク。メソッドは各ストーリーのタスクで足す。
 * 仕訳の起点は請求書・入金の表から引く。定期仕訳の表は US3 まで無いので、
 * テストが `registerOrigin` で登録した起点を最後に探す
 */
export class InMemoryInvoicingStore implements InvoicingStore {
  state: InvoicingState = {
    origins: {},
    audits: [],
    settings: null,
    billingTerms: [],
    workHours: [],
    invoices: [],
    items: [],
    payments: [],
  };

  get audits(): InvoicingAuditEntry[] {
    return this.state.audits;
  }

  /** 定期仕訳の起点（定期仕訳の表は US3 で足す）。請求・入金の起点は表から引く */
  registerOrigin(journalId: string, origin: JournalOrigin): void {
    this.state.origins[journalId] = structuredClone(origin);
  }

  appendInvoicingAudit(entry: InvoicingAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  getInvoiceSettings(): InvoiceSettings | null {
    return structuredClone(this.state.settings);
  }

  upsertInvoiceSettings(row: InvoiceSettings): void {
    this.state.settings = structuredClone(row);
  }

  maxInvoiceSeq(): number | null {
    return this.state.invoices.length === 0
      ? null
      : Math.max(...this.state.invoices.map((i) => i.seq));
  }

  listBillingTerms(): BillingTerms[] {
    return structuredClone(
      [...this.state.billingTerms].sort((a, b) => a.partnerId.localeCompare(b.partnerId)),
    );
  }

  getBillingTerms(partnerId: string): BillingTerms | null {
    const found = this.state.billingTerms.find((t) => t.partnerId === partnerId);
    return found === undefined ? null : structuredClone(found);
  }

  upsertBillingTerms(row: BillingTerms): void {
    this.state.billingTerms = [
      ...this.state.billingTerms.filter((t) => t.partnerId !== row.partnerId),
      structuredClone(row),
    ];
  }

  deleteBillingTerms(partnerId: string): void {
    this.state.billingTerms = this.state.billingTerms.filter((t) => t.partnerId !== partnerId);
  }

  listWorkHours(targetMonth: string): WorkHoursRow[] {
    return structuredClone(
      this.state.workHours
        .filter((w) => w.targetMonth === targetMonth)
        .sort((a, b) => a.partnerId.localeCompare(b.partnerId)),
    );
  }

  getWorkHours(partnerId: string, targetMonth: string): WorkHoursRow | null {
    const found = this.state.workHours.find(
      (w) => w.partnerId === partnerId && w.targetMonth === targetMonth,
    );
    return found === undefined ? null : structuredClone(found);
  }

  upsertWorkHours(row: WorkHoursRow): void {
    this.state.workHours = [
      ...this.state.workHours.filter(
        (w) => !(w.partnerId === row.partnerId && w.targetMonth === row.targetMonth),
      ),
      structuredClone(row),
    ];
  }

  insertInvoice(invoice: InvoiceRecord): void {
    const dup = this.state.invoices.some(
      (i) => i.id === invoice.id || i.seq === invoice.seq || i.invoiceNo === invoice.invoiceNo,
    );
    if (dup) throw new Error("UNIQUE constraint failed: invoices");
    this.state.invoices.push(structuredClone(invoice));
  }

  insertInvoiceItems(items: InvoiceItemRecord[]): void {
    this.state.items.push(...structuredClone(items));
  }

  getInvoice(id: string): InvoiceRecord | null {
    const found = this.state.invoices.find((i) => i.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  listInvoiceItems(invoiceId: string): InvoiceItemRecord[] {
    return structuredClone(
      this.state.items.filter((i) => i.invoiceId === invoiceId).sort((a, b) => a.lineNo - b.lineNo),
    );
  }

  listInvoices(query: {
    partnerId?: string | undefined;
    month?: string | undefined;
  }): InvoiceRecord[] {
    return structuredClone(
      this.state.invoices
        .filter(
          (i) =>
            (query.partnerId === undefined || i.partnerId === query.partnerId) &&
            (query.month === undefined || i.targetMonth === query.month),
        )
        .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.seq - a.seq),
    );
  }

  listActiveInvoices(partnerId: string, targetMonth: string): InvoiceRecord[] {
    return structuredClone(
      this.state.invoices
        .filter(
          (i) => i.partnerId === partnerId && i.targetMonth === targetMonth && i.voidedAt === null,
        )
        .sort((a, b) => a.seq - b.seq),
    );
  }

  markInvoiceVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const found = this.state.invoices.find((i) => i.id === id);
    if (found === undefined) throw new Error(`請求書がない: ${id}`);
    if (found.voidedAt !== null) throw new Error("取消済みの請求書は更新できません");
    found.voidedAt = voided.voidedAt;
    found.voidReason = voided.voidReason;
    found.voidJournalId = voided.voidJournalId;
  }

  listPayments(invoiceId: string): PaymentRecord[] {
    return structuredClone(this.state.payments.filter((p) => p.invoiceId === invoiceId));
  }

  insertPayment(payment: PaymentRecord): void {
    const dup = this.state.payments.some(
      (p) => p.id === payment.id || p.journalId === payment.journalId,
    );
    if (dup) throw new Error("UNIQUE constraint failed: invoice_payments");
    this.state.payments.push(structuredClone(payment));
  }

  markPaymentVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void {
    const found = this.state.payments.find((p) => p.id === id);
    if (found === undefined) throw new Error(`消し込みがない: ${id}`);
    if (found.voidedAt !== null) throw new Error("取消済みの消し込みは更新できません");
    found.voidedAt = voided.voidedAt;
    found.voidReason = voided.voidReason;
    found.voidJournalId = voided.voidJournalId;
  }

  originOfJournal(journalId: string): JournalOrigin | null {
    const invoice = this.state.invoices.find(
      (i) => i.journalId === journalId || i.voidJournalId === journalId,
    );
    if (invoice !== undefined) {
      return { kind: "invoice", invoiceId: invoice.id, invoiceNo: invoice.invoiceNo };
    }
    const payment = this.state.payments.find(
      (p) => p.journalId === journalId || p.voidJournalId === journalId,
    );
    if (payment !== undefined) {
      const owner = this.state.invoices.find((i) => i.id === payment.invoiceId);
      if (owner !== undefined) {
        return {
          kind: "payment",
          invoiceId: owner.id,
          invoiceNo: owner.invoiceNo,
          paymentId: payment.id,
        };
      }
    }
    const origin = this.state.origins[journalId];
    return origin === undefined ? null : structuredClone(origin);
  }
}

/** RecurringStore のフェイク。一意制約（定義 × 対象月、仕訳）の違反は例外（DB と同じ） */
export class InMemoryRecurringStore implements RecurringStore {
  state: {
    audits: InvoicingAuditEntry[];
    defs: Recurring[];
    runs: RecurringRunRecord[];
  } = { audits: [], defs: [], runs: [] };

  get audits(): InvoicingAuditEntry[] {
    return this.state.audits;
  }

  appendRecurringAudit(entry: InvoicingAuditEntry): void {
    this.state.audits.push(structuredClone(entry));
  }

  listRecurring(): Recurring[] {
    return structuredClone(
      [...this.state.defs].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }

  getRecurring(id: string): Recurring | null {
    const found = this.state.defs.find((d) => d.id === id);
    return found === undefined ? null : structuredClone(found);
  }

  insertRecurring(def: Recurring): void {
    if (this.state.defs.some((d) => d.id === def.id)) {
      throw new Error("UNIQUE constraint failed: recurring_journals.id");
    }
    this.state.defs.push(structuredClone(def));
  }

  updateRecurring(def: Recurring): void {
    const index = this.state.defs.findIndex((d) => d.id === def.id);
    if (index < 0) throw new Error(`定期仕訳がない: ${def.id}`);
    this.state.defs[index] = structuredClone(def);
  }

  listRuns(recurringId?: string): RecurringRunRecord[] {
    return structuredClone(
      this.state.runs
        .filter((r) => recurringId === undefined || r.recurringId === recurringId)
        .sort(
          (a, b) =>
            a.targetMonth.localeCompare(b.targetMonth) ||
            a.recurringId.localeCompare(b.recurringId),
        ),
    );
  }

  insertRun(run: RecurringRunRecord): void {
    const dup = this.state.runs.some(
      (r) =>
        r.id === run.id ||
        (r.recurringId === run.recurringId && r.targetMonth === run.targetMonth) ||
        (run.journalId !== null && r.journalId === run.journalId),
    );
    if (dup) throw new Error("UNIQUE constraint failed: recurring_runs");
    this.state.runs.push(structuredClone(run));
  }

  markRunsAcknowledged(runIds: string[], at: string): void {
    for (const id of runIds) {
      const found = this.state.runs.find((r) => r.id === id);
      if (found === undefined) throw new Error(`回がない: ${id}`);
      if (found.acknowledgedAt !== null) throw new Error("確認済みの回は更新できません");
      found.acknowledgedAt = at;
    }
  }
}

/** InvoicingUnitOfWork のフェイク（R9） */
export const fakeInvoicingUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  invoicing = new InMemoryInvoicingStore(),
) => fakeUnitOfWork(ledger, masters, { invoicing });
export type FakeInvoicingUnitOfWork = ReturnType<typeof fakeInvoicingUnitOfWork>;

/** RecurringUnitOfWork のフェイク */
export const fakeRecurringUnitOfWork = (
  ledger = new InMemoryLedgerRepository(),
  masters = new InMemoryMasterRepository(),
  recurring = new InMemoryRecurringStore(),
) => fakeUnitOfWork(ledger, masters, { recurring });
export type FakeRecurringUnitOfWork = ReturnType<typeof fakeRecurringUnitOfWork>;

/** メモリ上の SecretStore（キーチェーンの代わり） */
export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

interface FakeRecoveryCode {
  id: string;
  codeHash: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

interface FakePairingToken {
  id: string;
  tokenHash: string;
  rpId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

/** メモリ上の AuthStore。DB の実装と同じ振る舞い（追記のみの記録、単回のトークン）を持つ */
export class FakeAuthStore implements AuthStore {
  passkeys: Passkey[] = [];
  recoveryCodes: FakeRecoveryCode[] = [];
  sessions: Session[] = [];
  events: AuthEvent[] = [];
  pairingTokens: FakePairingToken[] = [];
  settings = new Map<AppSettingKey, { value: string; updatedAt: string }>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async listPasskeys(): Promise<Passkey[]> {
    return this.passkeys.map((p) => ({ ...p }));
  }
  async getPasskey(id: string): Promise<Passkey | undefined> {
    const p = this.passkeys.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }
  async addPasskey(passkey: NewPasskey): Promise<void> {
    if (this.passkeys.some((p) => p.id === passkey.id)) {
      throw new Error(`duplicate passkey: ${passkey.id}`);
    }
    this.passkeys.push({ ...passkey, lastUsedAt: null });
  }
  async renamePasskey(id: string, name: string): Promise<void> {
    const p = this.passkeys.find((x) => x.id === id);
    if (p) p.name = name;
  }
  async deletePasskey(id: string): Promise<void> {
    this.passkeys = this.passkeys.filter((p) => p.id !== id);
  }
  async recordPasskeyUse(id: string, counter: number, at: string): Promise<void> {
    const p = this.passkeys.find((x) => x.id === id);
    if (p) {
      p.counter = counter;
      p.lastUsedAt = at;
    }
  }

  async getActiveRecoveryCode(): Promise<{ id: string; codeHash: string } | undefined> {
    const r = this.recoveryCodes.find((x) => x.usedAt === null && x.revokedAt === null);
    return r ? { id: r.id, codeHash: r.codeHash } : undefined;
  }
  async replaceRecoveryCode(
    newCodeHash: string,
    now: string,
    closeAs: "used" | "revoked",
  ): Promise<void> {
    for (const r of this.recoveryCodes) {
      if (r.usedAt === null && r.revokedAt === null) {
        if (closeAs === "used") r.usedAt = now;
        else r.revokedAt = now;
      }
    }
    this.recoveryCodes.push({
      id: this.nextId("rc"),
      codeHash: newCodeHash,
      createdAt: now,
      usedAt: null,
      revokedAt: null,
    });
  }

  async createSession(s: NewSession): Promise<void> {
    if (this.sessions.some((x) => x.tokenHash === s.tokenHash)) {
      throw new Error("duplicate session token_hash");
    }
    this.sessions.push({
      id: s.id,
      tokenHash: s.tokenHash,
      kind: s.kind,
      rpId: s.rpId,
      passkeyId: s.passkeyId,
      userAgent: s.userAgent,
      createdAt: s.now,
      lastSeenAt: s.now,
      revokedAt: null,
    });
  }
  async findSessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const s = this.sessions.find((x) => x.tokenHash === tokenHash);
    return s ? { ...s } : undefined;
  }
  async touchSession(id: string, at: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) s.lastSeenAt = at;
  }
  async revokeSession(id: string, at: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s && s.revokedAt === null) s.revokedAt = at;
  }
  async revokeSessionsByPasskey(passkeyId: string, at: string): Promise<string[]> {
    const ids: string[] = [];
    for (const s of this.sessions) {
      if (s.passkeyId === passkeyId && s.revokedAt === null) {
        s.revokedAt = at;
        ids.push(s.id);
      }
    }
    return ids;
  }
  async listActiveSessions(now: string): Promise<Session[]> {
    return this.sessions.filter((s) => isSessionActive(s, now)).map((s) => ({ ...s }));
  }
  async deleteStaleSessions(before: string): Promise<number> {
    const keep = this.sessions.filter((s) => s.revokedAt === null || s.revokedAt >= before);
    const n = this.sessions.length - keep.length;
    this.sessions = keep;
    return n;
  }

  async appendEvent(e: NewAuthEvent): Promise<void> {
    this.events.push({
      id: e.id,
      occurredAt: e.occurredAt,
      kind: e.kind,
      rpId: e.rpId ?? null,
      passkeyId: e.passkeyId ?? null,
      sessionId: e.sessionId ?? null,
      userAgent: e.userAgent ?? null,
      detail: e.detail ?? null,
    });
  }
  private newestFirst(): AuthEvent[] {
    return this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) =>
        a.e.occurredAt < b.e.occurredAt ? 1 : a.e.occurredAt > b.e.occurredAt ? -1 : b.i - a.i,
      )
      .map((x) => ({ ...x.e }));
  }
  async listEvents(limit: number): Promise<AuthEvent[]> {
    return this.newestFirst().slice(0, limit);
  }
  async listEventsSince(since: string, kinds: AuthEventKind[]): Promise<AuthEvent[]> {
    return this.newestFirst().filter((e) => e.occurredAt >= since && kinds.includes(e.kind));
  }

  async createPairingToken(t: {
    id: string;
    tokenHash: string;
    rpId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    if (this.pairingTokens.some((x) => x.tokenHash === t.tokenHash)) {
      throw new Error("duplicate pairing token_hash");
    }
    this.pairingTokens.push({
      id: t.id,
      tokenHash: t.tokenHash,
      rpId: t.rpId,
      createdAt: t.now,
      expiresAt: t.expiresAt,
      usedAt: null,
    });
  }
  private findValidPairing(tokenHash: string, rpId: string, now: string) {
    return this.pairingTokens.find(
      (t) => t.tokenHash === tokenHash && t.rpId === rpId && t.usedAt === null && now < t.expiresAt,
    );
  }
  async isPairingTokenValid(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    return this.findValidPairing(tokenHash, rpId, now) !== undefined;
  }
  async consumePairingToken(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    const t = this.findValidPairing(tokenHash, rpId, now);
    if (!t) return false;
    t.usedAt = now;
    return true;
  }
  async deleteExpiredPairingTokens(before: string): Promise<number> {
    const keep = this.pairingTokens.filter((t) => t.expiresAt >= before);
    const n = this.pairingTokens.length - keep.length;
    this.pairingTokens = keep;
    return n;
  }

  async getSetting(key: AppSettingKey): Promise<string | undefined> {
    return this.settings.get(key)?.value;
  }
  async setSetting(key: AppSettingKey, value: string, now: string): Promise<void> {
    this.settings.set(key, { value, updatedAt: now });
  }
  async getOrCreateMacId(newId: () => string): Promise<string> {
    const existing = this.settings.get("mac_id");
    if (existing) return existing.value;
    const id = newId();
    this.settings.set("mac_id", { value: id, updatedAt: "" });
    return id;
  }
}

/** メモリ上の BackupStore（backup_runs だけ） */
export class FakeBackupStore implements BackupStore {
  runs: BackupRun[] = [];
  async recordRun(run: NewBackupRun): Promise<void> {
    this.runs.push({ ...run });
  }
  private newestFirst(): BackupRun[] {
    return [...this.runs].reverse();
  }
  async getLastRun(): Promise<BackupRun | undefined> {
    return this.newestFirst()[0];
  }
  async getLastCheck(): Promise<BackupRun | undefined> {
    return this.newestFirst().find((r) => r.status === "succeeded" || r.status === "skipped");
  }
  async getLastSuccess(): Promise<BackupRun | undefined> {
    return this.newestFirst().find((r) => r.status === "succeeded");
  }
  async listRuns(limit: number): Promise<BackupRun[]> {
    return this.newestFirst().slice(0, limit);
  }
}
