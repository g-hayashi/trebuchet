import type { BillingTerms, InvoiceSettings, JournalOrigin } from "@trebuchet/schema";
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
} from "./auth/types.ts";
import type {
  AccountMapping,
  ImportBatch,
  ImportRef,
  JournalSignature,
  TaxMapping,
} from "./import/types.ts";
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
  InvoicingAuditEntry,
  Journal,
  JournalLine,
  JournalQuery,
  JournalSource,
  OpeningBalance,
  Page,
  Partner,
  PostedLine,
  RentDetail,
  SubAccount,
  Tag,
  TaxCategory,
  TaxParameter,
  TaxRate,
  TaxReturnMemo,
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

/** 訂正後の仕訳の内容。行の ID もドメインで採番する */
export type JournalReplacement = Omit<ValidJournal, "lines"> & { lines: JournalLine[] };

/** 保存する新しい仕訳。行の ID もドメインで採番する */
export type NewJournal = Omit<ValidJournal, "lines"> & {
  id: string;
  journalNo: number;
  createdAt: string;
  lines: JournalLine[];
  /** 省略時は manual */
  source?: JournalSource | undefined;
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
  /** status active、source（省略時は manual）、version 1、updatedAt = createdAt で保存する */
  insertJournal(journal: NewJournal): Journal;
  getJournal(id: string): Journal | undefined;
  /** 新しい順（日付の降順、同じ日付は仕訳番号の降順）。取消済みを含む */
  recentJournals(limit: number): Journal[];
}

/** 仕訳の訂正・取消・履歴・検索（US3） */
export interface LedgerRepository extends JournalRepository {
  transaction<T>(fn: (tx: LedgerRepository) => T): T;
  /**
   * 日付・メモ・訂正元と行・タグを全件置き換え、version を +1 する。
   * version が一致しなければ RepositoryConflictError
   */
  replaceJournal(
    id: string,
    journal: JournalReplacement,
    expectedVersion: number,
    updatedAt: string,
  ): Journal;
  /** status を voided にし、version を +1 する（行は残す）。version が一致しなければ RepositoryConflictError */
  voidJournal(id: string, expectedVersion: number, updatedAt: string): Journal;
  /** 仕訳の audit_log（記録の順） */
  journalHistory(id: string): AuditEntry[];
  /** id を訂正元とする訂正仕訳（仕訳番号の順） */
  correctingJournalsOf(id: string): Journal[];
  /** 日付の降順・同じ日付は仕訳番号の降順。limit の既定は 50 */
  findJournals(query: JournalQuery): Page<Journal>;
}

/** 帳票の集計（US4 で実装する） */
export interface ReportRepository {
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
  /** target_type = fiscal_period の audit_log（締め・解除。全期間, 記録の順） */
  fiscalPeriodHistory(): AuditEntry[];

  listOpeningBalances(fiscalPeriodId: string): OpeningBalance[];
  replaceOpeningBalances(fiscalPeriodId: string, rows: OpeningBalance[]): void;
}

/** 取込の記録と対応表（002-freee-import。packages/db が実装）。メソッドはすべて同期 */
export interface ImportStore {
  /** sourceName の順 */
  listAccountMappings(): AccountMapping[];
  /** sourceName で追加・更新する */
  upsertAccountMappings(rows: AccountMapping[], updatedAt: string): void;
  /** sourceName の順 */
  listTaxMappings(): TaxMapping[];
  upsertTaxMappings(rows: TaxMapping[], updatedAt: string): void;
  /** 取り消されていない参照のうち、freee の仕訳ID が ids に含まれるもの */
  activeRefsByFreeeIds(ids: string[]): ImportRef[];
  /** 取り消されていない参照のうち、freee の日付が from〜to（両端を含む）のもの */
  activeRefsInRange(from: string, to: string): ImportRef[];
  insertBatch(batch: ImportBatch): void;
  insertRefs(refs: ImportRef[]): void;
  /** 新しい順（取込の日時の降順） */
  listBatches(): ImportBatch[];
  getBatch(id: string): ImportBatch | undefined;
  /** 取込の回で登録した仕訳と参照（仕訳番号の順）。取消済みの仕訳・参照を含む */
  journalsOfBatch(id: string): { journal: Journal; ref: ImportRef }[];
  /**
   * 取込の回を voided にし、その回の参照に revoked_at を設定する（仕訳の取消は呼び出し側が行う）。
   * 有効な取込の回がなければ例外
   */
  voidBatch(id: string, reason: string, at: string): void;
  /** 手入力（source = manual）の有効な仕訳の要約。日付が from〜to（両端を含む）のもの（R16） */
  manualJournalSignatures(from: string, to: string): JournalSignature[];
}

/** 取込の確定・取消で、仕訳・マスタ・取込の記録を1つのトランザクションで扱う（research R10, INV-11） */
export interface ImportUnitOfWork {
  /** fn が例外を投げると、fn の中の書き込みをすべて元に戻す */
  transaction<T>(
    fn: (tx: { ledger: LedgerRepository; masters: MasterRepository; imports: ImportStore }) => T,
  ): T;
}

/** 決算処理と確定申告の設定（003-tax-return。packages/db が実装）。メソッドはすべて同期 */
export interface ClosingStore {
  listTaxParameters(): TaxParameter[];
  listHomeUseAllocations(fiscalYear: number): HomeUseAllocation[];
  upsertHomeUseAllocation(row: HomeUseAllocation): void;
  listRentDetails(fiscalYear: number): RentDetail[];
  replaceRentDetails(fiscalYear: number, rows: RentDetail[]): void;
  listFixedAssets(): FixedAsset[];
  upsertFixedAsset(row: FixedAsset): void;
  listAdjustmentRefs(fiscalYear: number): AdjustmentRef[];
  insertAdjustmentRef(ref: AdjustmentRef): void;
  getDeductionAnswers(fiscalYear: number): DeductionAnswers | undefined;
  upsertDeductionAnswers(row: DeductionAnswers): void;
  listClosingNotes(fiscalYear: number): ClosingNote[];
  upsertClosingNote(row: ClosingNote): void;
  listTaxReturnMemos(fiscalYear: number): TaxReturnMemo[];
  upsertTaxReturnMemo(row: TaxReturnMemo): void;
  deleteTaxReturnMemo(id: string): void;
  listFiledDocuments(fiscalYear: number): FiledDocument[];
  upsertFiledDocument(row: FiledDocument): void;
  deleteFiledDocument(id: string): void;
  appendClosingAudit(entry: ClosingAuditEntry): void;
}

/** 決算整理の仕訳の登録で、仕訳・マスタ・決算の記録を1つのトランザクションで扱う（research R4） */
export interface ClosingUnitOfWork {
  /** fn が例外を投げると、fn の中の書き込みをすべて元に戻す */
  transaction<T>(
    fn: (tx: {
      journals: JournalRepository;
      masters: MasterRepository;
      closing: ClosingStore;
    }) => T,
  ): T;
}

/**
 * 請求書（005 US1・US4）の永続化。メソッドは各ストーリーの db のタスクで、ポートと実装を同時に足す。
 * 操作の記録は `invoicing_audit_log` を RecurringStore と共有する（R23）
 */
export interface InvoicingStore {
  appendInvoicingAudit(entry: InvoicingAuditEntry): void;
  /** 発行者の設定（`invoice_settings` の 1 行）。なければ null */
  getInvoiceSettings(): InvoiceSettings | null;
  upsertInvoiceSettings(row: InvoiceSettings): void;
  /** 発行済み（取消を含む）の請求書の最大の `seq`。1 件もなければ null（R6） */
  maxInvoiceSeq(): number | null;
  /** 請求の条件の全件（取引先の ID の順） */
  listBillingTerms(): BillingTerms[];
  getBillingTerms(partnerId: string): BillingTerms | null;
  upsertBillingTerms(row: BillingTerms): void;
  deleteBillingTerms(partnerId: string): void;
  /** 仕訳が請求・入金・定期仕訳のどれから作られたか（H:§6.1）。取消の仕訳も元の請求・入金を指す。なければ null */
  originOfJournal(journalId: string): JournalOrigin | null;
}

/** 請求書の発行・入金・取消で、仕訳・マスタ・請求の記録を1つのトランザクションで扱う（R9） */
export interface InvoicingUnitOfWork {
  /** fn が例外を投げると、fn の中の書き込みをすべて元に戻す。`err` を返しても確定する（R9） */
  transaction<T>(
    fn: (tx: {
      ledger: LedgerRepository;
      masters: MasterRepository;
      invoicing: InvoicingStore;
    }) => T,
  ): T;
}

/** 定期仕訳（005 US3）の永続化。メソッドは US3 の db のタスクで足す */
export interface RecurringStore {
  appendRecurringAudit(entry: InvoicingAuditEntry): void;
}

/** 定期仕訳の登録で、仕訳・マスタ・定期仕訳の記録を1つのトランザクションで扱う（R9） */
export interface RecurringUnitOfWork {
  /** fn が例外を投げると、fn の中の書き込みをすべて元に戻す。`err` を返しても確定する（R9） */
  transaction<T>(
    fn: (tx: {
      ledger: LedgerRepository;
      masters: MasterRepository;
      recurring: RecurringStore;
    }) => T,
  ): T;
}

/** 事業体の一覧（data/registry.sqlite） */
export interface RegistryRepository {
  listEntities(): EntitySummary[];
  getEntity(id: string): EntitySummary | undefined;
  insertEntity(entity: EntitySummary): void;
  renameEntity(id: string, name: string): void;
}

/** macOS キーチェーン（R12）。テストはメモリの偽物。キーチェーンが使えない環境ではメモリの実装 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** passkeys・recovery_codes・sessions・auth_events・pairing_tokens・app_settings（registry） */
export interface AuthStore {
  // パスキー
  listPasskeys(): Promise<Passkey[]>;
  getPasskey(id: string): Promise<Passkey | undefined>;
  addPasskey(passkey: NewPasskey): Promise<void>;
  renamePasskey(id: string, name: string): Promise<void>;
  deletePasskey(id: string): Promise<void>;
  /** counter と last_used_at を更新する */
  recordPasskeyUse(id: string, counter: number, at: string): Promise<void>;
  // 回復コード（ハッシュは hashToken）
  getActiveRecoveryCode(): Promise<{ id: string; codeHash: string } | undefined>;
  /** 古い有効な行を closeAs で閉じて新しい行を追加する（1 トランザクション） */
  replaceRecoveryCode(newCodeHash: string, now: string, closeAs: "used" | "revoked"): Promise<void>;
  // セッション
  createSession(session: NewSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | undefined>;
  touchSession(id: string, at: string): Promise<void>;
  revokeSession(id: string, at: string): Promise<void>;
  /** 失効したセッションの id を返す */
  revokeSessionsByPasskey(passkeyId: string, at: string): Promise<string[]>;
  listActiveSessions(now: string): Promise<Session[]>;
  /** 失効済みで before より古いものを消す。消した件数を返す */
  deleteStaleSessions(before: string): Promise<number>;
  // 認証の記録（追記のみ）
  appendEvent(event: NewAuthEvent): Promise<void>;
  /** 新しい順 */
  listEvents(limit: number): Promise<AuthEvent[]>;
  /** recoveryLocked の入力 */
  listEventsSince(since: string, kinds: AuthEventKind[]): Promise<AuthEvent[]>;
  // ペアリングのトークン（ハッシュは hashToken）
  createPairingToken(token: {
    id: string;
    tokenHash: string;
    rpId: string;
    now: string;
    expiresAt: string;
  }): Promise<void>;
  isPairingTokenValid(tokenHash: string, rpId: string, now: string): Promise<boolean>;
  /** 有効なら used_at を付けて true（単回） */
  consumePairingToken(tokenHash: string, rpId: string, now: string): Promise<boolean>;
  deleteExpiredPairingTokens(before: string): Promise<number>;
  // アプリの設定（app_settings の読み書きはここに寄せる）
  getSetting(key: AppSettingKey): Promise<string | undefined>;
  setSetting(key: AppSettingKey, value: string, now: string): Promise<void>;
  getOrCreateMacId(newId: () => string): Promise<string>;
}

/** backup_runs だけ（app_settings は AuthStore の getSetting・setSetting） */
export interface BackupStore {
  /** 終わった実行を 1 行追加する */
  recordRun(run: NewBackupRun): Promise<void>;
  getLastRun(): Promise<BackupRun | undefined>;
  /** 最後の succeeded または skipped */
  getLastCheck(): Promise<BackupRun | undefined>;
  /** 最後の succeeded */
  getLastSuccess(): Promise<BackupRun | undefined>;
  /** 新しい順 */
  listRuns(limit: number): Promise<BackupRun[]>;
}
