import type { MasterRepository } from "../../src/ports.ts";
import type {
  Account,
  AuditEntry,
  EntityProfile,
  FiscalPeriod,
  OpeningBalance,
  Partner,
  Result,
  SubAccount,
  Tag,
  TaxCategory,
  TaxRate,
  TaxSetting,
} from "../../src/types.ts";

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
