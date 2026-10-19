import {
  type Clock,
  type IdGenerator,
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
      source: "manual",
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
