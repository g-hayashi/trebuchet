import type {
  BillingTerms,
  InvoiceSettings,
  JournalOrigin,
  Recurring,
  StatementAccount,
  StatementBatch,
  StatementSettings,
} from "@trebuchet/schema";
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
  InvoiceItemRecord,
  InvoiceRecord,
  InvoicingAuditEntry,
  Journal,
  JournalLine,
  JournalQuery,
  JournalSource,
  OpeningBalance,
  Page,
  Partner,
  PaymentRecord,
  PostedLine,
  RecurringRunRecord,
  RentDetail,
  Result,
  StatementAuditEntry,
  StatementCandidateRecord,
  StatementLinkRecord,
  StatementRecord,
  SubAccount,
  Tag,
  TaxCategory,
  TaxParameter,
  TaxRate,
  TaxReturnMemo,
  TaxSetting,
  ValidJournal,
  WorkHoursRow,
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
  /**
   * fn を 1 つのトランザクションで実行する（入れ子は SAVEPOINT）。fn が `err` を返すか例外を投げると、
   * fn の中の書き込みをすべて巻き戻し、同じ `err` を返す・同じ例外を投げ直す（TenantUnitOfWork と同じ）
   */
  transaction<T>(fn: (tx: JournalRepository) => Result<T>): Result<T>;
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
  transaction<T>(fn: (tx: LedgerRepository) => Result<T>): Result<T>;
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
  /** JournalRepository.transaction と同じ（`err` か例外で巻き戻す） */
  transaction<T>(fn: (tx: MasterRepository) => Result<T>): Result<T>;

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

/** UnitOfWork の `run` の中で使う、同じトランザクションの帳簿・マスタと、機能ごとのストア */
export type TenantTx<Extra extends object> = {
  ledger: LedgerRepository;
  masters: MasterRepository;
} & Extra;

/**
 * 1 つの事業体の DB に対するトランザクション（Unit of Work）。複数回書くユースケースは、この中で書く。
 * packages/db が実装する（`drizzleUnitOfWork`）。テストのフェイクは `FakeUnitOfWork`
 */
export interface TenantUnitOfWork<Extra extends object> {
  /**
   * fn を 1 つのトランザクションで実行する。fn が `ok` を返せば確定する。
   * fn が `err` を返すと fn の中の書き込みをすべて巻き戻し、同じ `err` を返す。
   * fn が例外を投げると巻き戻し、同じ例外を投げ直す。
   * 同じ UnitOfWork の `run` の中で `run` を呼ばない（入れ子のトランザクションにはならない）
   */
  run<T>(fn: (tx: TenantTx<Extra>) => Result<T>): Result<T>;
}

/** 取込の確定・取消で、仕訳・マスタ・取込の記録を1つのトランザクションで扱う（research R10, INV-11） */
export type ImportUnitOfWork = TenantUnitOfWork<{ imports: ImportStore }>;

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

/** 決算整理の仕訳の登録・決算の設定の保存で、仕訳・マスタ・決算の記録を1つのトランザクションで扱う（research R4） */
export type ClosingUnitOfWork = TenantUnitOfWork<{ closing: ClosingStore }>;

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
  /** 対象月の工数（取引先の ID の順） */
  listWorkHours(targetMonth: string): WorkHoursRow[];
  getWorkHours(partnerId: string, targetMonth: string): WorkHoursRow | null;
  /** （取引先, 対象月）で上書きする */
  upsertWorkHours(row: WorkHoursRow): void;
  /** 請求書の写しを保存する（明細は `insertInvoiceItems`。発行は同じトランザクションで両方を呼ぶ） */
  insertInvoice(invoice: InvoiceRecord): void;
  insertInvoiceItems(items: InvoiceItemRecord[]): void;
  getInvoice(id: string): InvoiceRecord | null;
  /** 行番号の順 */
  listInvoiceItems(invoiceId: string): InvoiceItemRecord[];
  /** 発行日の降順（同じ日は `seq` の降順）。取消済みを含む。`partnerId`・`month`（対象月）で絞り込む */
  listInvoices(query: {
    partnerId?: string | undefined;
    month?: string | undefined;
  }): InvoiceRecord[];
  /** 取引先・対象月の取消でない請求書（`seq` の順。重複の警告・確認に使う。FR-016） */
  listActiveInvoices(partnerId: string, targetMonth: string): InvoiceRecord[];
  /** 請求書を取消済みにする（取消の列を NULL から一度だけ書く。写しは変えない） */
  markInvoiceVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void;
  /** 請求書の消し込み（取消済みを含む。登録の順） */
  listPayments(invoiceId: string): PaymentRecord[];
  /** 消し込みを保存する（入金の仕訳と同じトランザクションで呼ぶ。`journalId` は一意） */
  insertPayment(payment: PaymentRecord): void;
  /** 消し込みを取消済みにする（取消の列を NULL から一度だけ書く。写しは変えない） */
  markPaymentVoided(
    id: string,
    voided: { voidedAt: string; voidReason: string; voidJournalId: string | null },
  ): void;
  /** 仕訳が請求・入金・定期仕訳のどれから作られたか（H:§6.1）。取消の仕訳も元の請求・入金を指す。なければ null */
  originOfJournal(journalId: string): JournalOrigin | null;
}

/** 請求書の発行・入金・取消で、仕訳・マスタ・請求の記録を1つのトランザクションで扱う（R9） */
export type InvoicingUnitOfWork = TenantUnitOfWork<{ invoicing: InvoicingStore }>;

/** 定期仕訳（005 US3）の永続化。メソッドはすべて同期。操作の記録は `invoicing_audit_log`（R23） */
export interface RecurringStore {
  appendRecurringAudit(entry: InvoicingAuditEntry): void;
  /** 定義の全件（行を含む。行番号の順）。作成の順（`createdAt`、同じなら `id`） */
  listRecurring(): Recurring[];
  getRecurring(id: string): Recurring | null;
  /** 定義と行を保存する（`id`・`version`・`createdAt` は呼び出し側が決める） */
  insertRecurring(def: Recurring): void;
  /** 定義の列を上書きし、行を全件置き換える（`version` の検査はドメインが先に行う。R16） */
  updateRecurring(def: Recurring): void;
  /** 回の全件、または 1 つの定義の回（対象月の昇順） */
  listRuns(recurringId?: string): RecurringRunRecord[];
  /** 回を保存する。（定義, 対象月）の重複と、同じ仕訳の再利用は一意制約の違反で例外（R19） */
  insertRun(run: RecurringRunRecord): void;
  /** 回を確認済みにする（`acknowledged_at` を NULL から一度だけ書く。R21） */
  markRunsAcknowledged(runIds: string[], at: string): void;
}

/** 定期仕訳の登録で、仕訳・マスタ・定期仕訳の記録を1つのトランザクションで扱う（R9） */
export type RecurringUnitOfWork = TenantUnitOfWork<{ recurring: RecurringStore }>;

/**
 * 明細の取込と AI 仕訳（006）の永続化。メソッドはすべて同期。各ストーリーの db のタスクで、
 * ポートと実装（`DrizzleStatementStore`）・偽物（`InMemoryStatementStore`）を同時に足す。
 * 操作の記録は `statement_audit_log`（R18）
 */
export interface StatementStore {
  appendStatementAudit(entry: StatementAuditEntry): void;

  // ---- 取込元の口座（US1。data-model §1.1） ----
  /** 名前の順 */
  listStatementAccounts(): StatementAccount[];
  /** `account.id` が保存済みなら更新、なければ追加する（名前は一意） */
  upsertStatementAccount(account: StatementAccount): void;

  // ---- 取込（US1。§1.2・§1.3） ----
  insertStatementBatch(batch: StatementBatch): void;
  /** 新しい順（作成の日時の降順） */
  listStatementBatches(): StatementBatch[];
  /** 全件を追加する。`stable_key`・`external_id` の重複は例外（INV-40） */
  insertStatements(rows: StatementRecord[]): void;
  /** 取り込んだ順（`rowid`） */
  listStatements(): StatementRecord[];
  /** `changed_json` を書き、`changed_ack_at` を NULL に戻す（FR-005）。明細がなければ例外 */
  markStatementChanged(id: string, changedJson: string): void;
  /** `changed_ack_at` を書く（「確認した」。FR-005）。明細がなければ例外 */
  acknowledgeStatementChange(id: string, at: string): void;
  /** 除外する（`{ at, reason }`）か、除外を取り消す（null。`excluded_*` を NULL に戻す）。明細がなければ例外（FR-017） */
  setStatementExcluded(id: string, excluded: { at: string; reason: string | null } | null): void;

  // ---- 候補（US2。§1.4） ----
  /** 明細ごとに高々 1 件。並びは問わない */
  listStatementCandidates(): StatementCandidateRecord[];
  /** `statementId` の候補があれば置き換え、なければ追加する。形（`none` は purpose・confidence・draft が null）は CHECK */
  upsertStatementCandidate(candidate: StatementCandidateRecord): void;
  deleteStatementCandidate(statementId: string): void;

  // ---- 結びつき（US2。§1.5。書き込みは承認・取消のタスク（T015）が使う） ----
  /** 失効したものを含む全件（作成の順） */
  listStatementLinks(): StatementLinkRecord[];
  /** 有効な結びつきの重複（明細ごと・仕訳の行ごと）は一意制約の違反で例外（INV-43） */
  insertStatementLink(link: StatementLinkRecord): void;
  /** 有効な結びつきを失効させる（`revoked_at`・`revoked_reason`）。ない・失効済みなら例外 */
  revokeStatementLink(id: string, at: string, reason: string): void;

  // ---- 設定（US2。§1.8） ----
  /** 保存がなければ undefined */
  getStatementSettings(): StatementSettings | undefined;
  saveStatementSettings(settings: StatementSettings): void;
}

/** 明細の取込・承認で、仕訳・マスタ・明細の記録を1つのトランザクションで扱う（INV-47。data-model §6） */
export type StatementUnitOfWork = TenantUnitOfWork<{ statements: StatementStore }>;

/** AI に渡す明細の内容（`buildAiPayload` の出力。R11）。形は US5 のタスクで決める */
export type SuggestionPayload = Readonly<Record<string, unknown>>;
/** AI に渡す文脈（相手になりうる科目、税区分のコード。R10）。形は US5 のタスクで決める */
export type SuggestionContext = Readonly<Record<string, unknown>>;

/**
 * AI の推定（端末内・外部の 2 つの実装を渡す。R10）。出力は `unknown` で返し、ドメインの
 * `parseSuggestion` が検証する（INV-46）。ネットワーク・プロセスを使うので非同期
 */
export interface SuggestionProvider {
  /** 使える（接続先・モデルなどがそろっている）か */
  available(): Promise<boolean>;
  suggest(payload: SuggestionPayload, context: SuggestionContext): Promise<Result<unknown>>;
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
