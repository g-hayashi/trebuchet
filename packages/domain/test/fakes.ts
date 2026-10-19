import type {
  AccountMapping,
  ImportBatch,
  ImportRef,
  JournalSignature,
  TaxMapping,
} from "../src/import/types.ts";
import {
  type Clock,
  type IdGenerator,
  type ImportStore,
  type ImportUnitOfWork,
  type JournalReplacement,
  type LedgerRepository,
  type MasterRepository,
  type NewJournal,
  type RegistryRepository,
  RepositoryConflictError,
} from "../src/ports.ts";
import type {
  Account,
  AuditEntry,
  EntityProfile,
  EntitySummary,
  FiscalPeriod,
  Journal,
  JournalQuery,
  OpeningBalance,
  Page,
  Partner,
  SubAccount,
  Tag,
  TaxCategory,
  TaxRate,
  TaxSetting,
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
 * MasterRepository のフェイク。transaction は例外のときに状態を巻き戻す。
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

  transaction<T>(fn: (tx: MasterRepository) => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return fn(this);
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

/** LedgerRepository のフェイク。transaction は例外のときに状態を巻き戻す */
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

  transaction<T>(fn: (tx: LedgerRepository) => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return fn(this);
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

/**
 * ImportUnitOfWork のフェイク。001 のフェイクのリポジトリと InMemoryImportStore を組み合わせ、
 * transaction が例外で終わると3つの状態をすべて元に戻す（INV-11）
 */
export class FakeImportUnitOfWork implements ImportUnitOfWork {
  readonly ledger: InMemoryLedgerRepository;
  readonly masters: InMemoryMasterRepository;
  readonly imports: InMemoryImportStore;

  constructor(
    ledger = new InMemoryLedgerRepository(),
    masters = new InMemoryMasterRepository(),
    imports?: InMemoryImportStore,
  ) {
    this.ledger = ledger;
    this.masters = masters;
    this.imports = imports ?? new InMemoryImportStore(ledger);
  }

  transaction<T>(
    fn: (tx: { ledger: LedgerRepository; masters: MasterRepository; imports: ImportStore }) => T,
  ): T {
    const snapshot = structuredClone({
      ledger: this.ledger.state,
      masters: this.masters.state,
      imports: this.imports.state,
    });
    try {
      return fn({ ledger: this.ledger, masters: this.masters, imports: this.imports });
    } catch (e) {
      this.ledger.state = snapshot.ledger;
      this.masters.state = snapshot.masters;
      this.imports.state = snapshot.imports;
      throw e;
    }
  }
}
