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
  PostedLine,
  SubAccount,
  Tag,
  TaxCategory,
  TaxRate,
  TaxSetting,
  ValidJournal,
} from "./types.ts";

export interface IdGenerator {
  next(): string;
}

export interface Clock {
  /** ISO 8601（UTC） */
  now(): string;
}

/** 楽観ロックの不一致など、リポジトリが検出した競合 */
export class RepositoryConflictError extends Error {
  readonly code = "VERSION_CONFLICT" as const;
}

export type NewJournal = ValidJournal & {
  id: string;
  journalNo: number;
  createdAt: string;
};

export interface AuditLog {
  appendAudit(entry: AuditEntry): void;
}

/** 仕訳の読み書き（packages/db が実装）。メソッドはすべて同期 */
export interface LedgerRepository extends AuditLog {
  transaction<T>(fn: (tx: LedgerRepository) => T): T;
  nextJournalNo(): number;
  lastJournal(): Journal | undefined;
  insertJournal(journal: NewJournal): Journal;
  /** 行を全件置き換え、version を +1 する。version が一致しなければ RepositoryConflictError */
  replaceJournal(
    id: string,
    journal: ValidJournal,
    expectedVersion: number,
    updatedAt: string,
  ): Journal;
  /** status を voided にし、version を +1 する。version が一致しなければ RepositoryConflictError */
  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal;
  getJournal(id: string): Journal | undefined;
  journalHistory(id: string): AuditEntry[];
  correctingJournalsOf(id: string): Journal[];
  findJournals(query: JournalQuery): Page<Journal>;
  /** 期間内の有効な仕訳の行（取消済みは含まない） */
  linesInRange(from: string, to: string): PostedLine[];
  openingBalances(fiscalYear: number): OpeningBalance[];
}

/** マスタの読み書き（packages/db が実装） */
export interface MasterRepository extends AuditLog {
  transaction<T>(fn: (tx: MasterRepository) => T): T;

  getProfile(): EntityProfile | undefined;
  saveProfile(profile: EntityProfile): void;

  /** sortOrder, code の順 */
  listAccounts(): Account[];
  getAccount(id: string): Account | undefined;
  insertAccount(account: Account): void;
  updateAccount(account: Account): void;
  /** 科目とその補助科目を削除する（未使用であることは呼び出し側が isAccountUsed で確認済み） */
  deleteAccount(id: string): void;
  /** 仕訳行（取消済みを含む）または期首残高から参照されているか */
  isAccountUsed(accountId: string): boolean;

  listSubAccounts(accountId?: string): SubAccount[];
  insertSubAccount(subAccount: SubAccount): void;

  listPartners(): Partner[];
  insertPartner(partner: Partner): void;
  updatePartner(partner: Partner): void;

  listTags(): Tag[];
  insertTag(tag: Tag): void;

  listTaxCategories(): TaxCategory[];
  listTaxRates(): TaxRate[];
  /** effectiveFrom の順 */
  listTaxSettings(): TaxSetting[];
  replaceTaxSettings(settings: TaxSetting[]): void;

  /** fiscalYear の順 */
  listFiscalPeriods(): FiscalPeriod[];
  getFiscalPeriodByYear(fiscalYear: number): FiscalPeriod | undefined;
  insertFiscalPeriod(period: FiscalPeriod): void;
  updateFiscalPeriod(period: FiscalPeriod): void;

  listOpeningBalances(fiscalPeriodId: string): OpeningBalance[];
  replaceOpeningBalances(fiscalPeriodId: string, rows: OpeningBalance[]): void;
}

/** 事業体の一覧（data/registry.sqlite） */
export interface RegistryRepository {
  listEntities(): EntitySummary[];
  getEntity(id: string): EntitySummary | undefined;
  insertEntity(entity: EntitySummary): void;
  renameEntity(id: string, name: string): void;
}
