import type {
  Account,
  AuditEntry,
  EntityProfile,
  EntitySummary,
  FiscalPeriod,
  Journal,
  JournalLine,
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

/** 保存する新しい仕訳。行の ID もドメインで採番する */
export type NewJournal = Omit<ValidJournal, "lines"> & {
  id: string;
  journalNo: number;
  createdAt: string;
  lines: JournalLine[];
};

export interface AuditLog {
  appendAudit(entry: AuditEntry): void;
}

/** 仕訳の登録と参照（packages/db が実装）。メソッドはすべて同期 */
export interface JournalRepository extends AuditLog {
  transaction<T>(fn: (tx: JournalRepository) => T): T;
  /** 次の仕訳番号（INV-8）。同じトランザクションの中で insertJournal する */
  nextJournalNo(): number;
  /** 仕訳番号が最大の仕訳（取消済みを含む） */
  lastJournal(): Journal | undefined;
  /** status active、source manual、version 1、updatedAt = createdAt で保存する */
  insertJournal(journal: NewJournal): Journal;
  getJournal(id: string): Journal | undefined;
  /** 新しい順（日付の降順、同じ日付は仕訳番号の降順）。取消済みを含む */
  recentJournals(limit: number): Journal[];
}

/** 仕訳の訂正・取消・検索と帳票の集計（US3 以降で実装する） */
export interface LedgerRepository extends JournalRepository {
  transaction<T>(fn: (tx: LedgerRepository) => T): T;
  /** 行を全件置き換え、version を +1 する。version が一致しなければ RepositoryConflictError */
  replaceJournal(
    id: string,
    journal: ValidJournal,
    expectedVersion: number,
    updatedAt: string,
  ): Journal;
  /** status を voided にし、version を +1 する。version が一致しなければ RepositoryConflictError */
  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal;
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
