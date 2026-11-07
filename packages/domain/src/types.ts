import type {
  AccountCategory,
  AccountingMethod,
  AdjustmentKind,
  CandidateMethod,
  ClosingNoteKind,
  DepreciationMethod,
  EntityKind,
  ErrorCode,
  ErrorDetails,
  InvoiceIssuer,
  InvoicePriceMode,
  InvoiceTaxDisplay,
  JournalSource,
  PaymentView,
  Purpose,
  ReceiptCategory,
  ReceiptChannel,
  ReceiptMediaType,
  ReceiptReadingStatus,
  ReportSection,
  RuleHistoryAction,
  RuleManagedBy,
  RuleOrigin,
  RuleStatus,
  Side,
  StatementLinkKind,
  TaxCategoryCode,
  TaxpayerStatus,
  WarningCode,
} from "@trebuchet/schema";

export type {
  AccountCategory,
  AccountingMethod,
  EntityKind,
  ReportSection,
  Side,
  TaxCategoryCode,
  TaxpayerStatus,
};

// ---- Result ----

export type Result<T, E = DomainError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });

export type DomainError = {
  code: ErrorCode;
  message: string;
  details?: ErrorDetails | undefined;
};

/** 登録は成功したが利用者に知らせること（FR-018 など） */
export type DomainWarning = {
  code: WarningCode;
  message: string;
  details?: ErrorDetails | undefined;
};

export const domainError = (
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): DomainError => (details === undefined ? { code, message } : { code, message, details });

/** `VALIDATION` の `DomainError` */
export const validationError = (message: string, details?: ErrorDetails): DomainError =>
  domainError("VALIDATION", message, details);

/** `VALIDATION` の失敗（`err(validationError(...))`） */
export const validation = (message: string, details?: ErrorDetails) =>
  err(validationError(message, details));

/** 会計期間がない（`VALIDATION`、`details.fiscalYear` に年度）。HTTP のパスの年度は文字列のまま渡せる */
export const periodNotFound = (fiscalYear: number | string): DomainError =>
  validationError("会計期間が見つかりません", { fiscalYear });

// ---- 事業体・マスタ ----

export type EntitySummary = {
  id: string;
  name: string;
  kind: EntityKind;
  createdAt: string;
};

export type EntityProfile = EntitySummary & {
  fiscalStartMonth: number;
};

export type FiscalPeriodStatus = "open" | "closed";

export type FiscalPeriod = {
  id: string;
  fiscalYear: number;
  startDate: string;
  endDate: string;
  status: FiscalPeriodStatus;
  closedAt: string | null;
};

export type Account = {
  id: string;
  code: string;
  name: string;
  category: AccountCategory;
  normalSide: Side;
  reportSection: ReportSection;
  reportLine: number | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
};

export type SubAccount = {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
};

export type Honorific = "様" | "御中";

export type Partner = {
  id: string;
  name: string;
  honorific: Honorific | null;
  memo: string | null;
  isActive: boolean;
};

export type Tag = { id: string; name: string };

export type TaxCategoryKind = "sales" | "purchase";

export type TaxCategory = {
  code: TaxCategoryCode;
  name: string;
  kind: TaxCategoryKind | null;
};

export type TaxRate = {
  categoryCode: TaxCategoryCode;
  rate: number;
  effectiveFrom: string;
  sourceUrl: string;
};

export type TaxSetting = {
  id: string;
  effectiveFrom: string;
  taxpayerStatus: TaxpayerStatus;
  accountingMethod: AccountingMethod;
};

export type OpeningBalance = {
  id: string;
  fiscalPeriodId: string;
  accountId: string;
  subAccountId: string | null;
  side: Side;
  amount: number;
};

// ---- 仕訳 ----

export type LineDraft = {
  side: Side;
  accountId: string;
  subAccountId?: string | undefined;
  amount: number;
  taxCategory?: TaxCategoryCode | undefined;
  partnerId?: string | undefined;
  description?: string | undefined;
  tagIds?: string[] | undefined;
};

export type JournalDraft = {
  date: string;
  memo?: string | undefined;
  correctsJournalId?: string | undefined;
  lines: LineDraft[];
};

export type ValidLine = {
  lineNo: number;
  side: Side;
  accountId: string;
  subAccountId: string | null;
  amount: number;
  taxCategory: TaxCategoryCode;
  taxAmount: number;
  partnerId: string | null;
  description: string | null;
  tagIds: string[];
};

export type ValidJournal = {
  date: string;
  fiscalPeriodId: string;
  memo: string | null;
  correctsJournalId: string | null;
  lines: ValidLine[];
};

export type JournalStatus = "active" | "voided";
export type { JournalSource };

export type JournalLine = ValidLine & { id: string };

export type Journal = {
  id: string;
  journalNo: number;
  date: string;
  fiscalPeriodId: string;
  memo: string | null;
  status: JournalStatus;
  correctsJournalId: string | null;
  source: JournalSource;
  version: number;
  createdAt: string;
  updatedAt: string;
  lines: JournalLine[];
};

/**
 * 帳票の集計に使う仕訳の行（仕訳の情報と、科目・補助科目・取引先の名前つき）。
 * リポジトリは有効な仕訳だけを返すが、帳票の関数も status で取消済みを除く（INV-6）
 */
export type PostedLine = {
  journalId: string;
  journalNo: number;
  date: string;
  memo: string | null;
  /** 仕訳の登録日時（仕訳帳の並びに使う） */
  createdAt: string;
  status: JournalStatus;
  lineNo: number;
  side: Side;
  accountId: string;
  accountName: string;
  subAccountId: string | null;
  subAccountName: string | null;
  amount: number;
  taxCategory: TaxCategoryCode;
  taxAmount: number;
  partnerId: string | null;
  partnerName: string | null;
  description: string | null;
};

// ---- 監査 ----

export type AuditTargetType =
  | "journal"
  | "account"
  | "fiscal_period"
  | "opening_balance"
  | "tax_setting";

export type AuditAction =
  | "create"
  | "correct"
  | "void"
  | "rename"
  | "deactivate"
  | "close"
  | "reopen"
  | "replace";

/**
 * 監査の記録の 1 行（追記のみ）。既定は 001 の audit_log。決算（closing_audit_log）と
 * 請求・定期仕訳（invoicing_audit_log）は対象と操作の型だけが違う。作るときは `auditEntry`（audit.ts）を使う
 */
export type AuditEntry<
  TTarget extends string = AuditTargetType,
  TAction extends string = AuditAction,
> = {
  id: string;
  occurredAt: string;
  targetType: TTarget;
  targetId: string;
  action: TAction;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
};

/** 訂正元・訂正仕訳への参照（FR-019a） */
export type JournalRef = Pick<Journal, "id" | "journalNo" | "date" | "status">;

/** 仕訳と、訂正元・訂正仕訳への参照 */
export type JournalDetail = {
  journal: Journal;
  correctsJournal: JournalRef | null;
  correctingJournals: JournalRef[];
};

/** 仕訳の変更履歴の1項目（FR-020, SC-005）。before・after は audit_log の JSON を戻した仕訳 */
export type JournalHistoryEntry = {
  occurredAt: string;
  action: Extract<AuditAction, "create" | "correct" | "void">;
  reason: string | null;
  before: Journal | null;
  after: Journal | null;
};

// ---- 検索 ----

/** 検索の条件（FR-023）。cursor は直前のページの最後の仕訳の「日付_仕訳番号」 */
export type JournalQuery = {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  amountMin?: number | undefined;
  amountMax?: number | undefined;
  partnerId?: string | undefined;
  accountId?: string | undefined;
  q?: string | undefined;
  tagId?: string | undefined;
  includeVoided?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

// ---- 決算処理・確定申告（003-tax-return。data-model §1 の各表に対応する） ----

export type { AdjustmentKind, ClosingNoteKind, DepreciationMethod };

export type TaxParameterKey =
  | "SMALL_ASSET_THRESHOLD"
  | "SMALL_ASSET_ANNUAL_LIMIT"
  | "BLUE_DEDUCTION_MAX"
  | "BLUE_DEDUCTION_STANDARD"
  | "BLUE_DEDUCTION_BASIC"
  // 009: 一括償却資産と開業費（data-model §1.2）
  | "LUMP_SUM_COST_MIN"
  | "LUMP_SUM_COST_MAX"
  | "LUMP_SUM_YEARS"
  | "OPENING_COST_AMORTIZATION_MONTHS"
  // 010: 電子帳簿保存法の入力期間と解像度の目安（data-model §1.6）
  | "RECEIPT_INPUT_CYCLE_MONTHS"
  | "RECEIPT_INPUT_GRACE_BUSINESS_DAYS"
  | "RECEIPT_SCAN_MIN_LONG_PX"
  | "RECEIPT_SCAN_MIN_SHORT_PX"
  // 013: 報酬・料金の源泉徴収（境目の円、万分率の率。復興特別所得税を含む。data-model §1.1）
  | "WITHHOLDING_THRESHOLD"
  | "WITHHOLDING_RATE_LOW"
  | "WITHHOLDING_RATE_HIGH";

/** 税制の値（R3、§1.1）。effectiveTo が null なら期限なし */
export type TaxParameter = {
  key: TaxParameterKey;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: number;
  sourceUrl: string;
};

/** 家事按分の登録（§1.2）。businessRatio は万分率 */
export type HomeUseAllocation = {
  id: string;
  fiscalYear: number;
  accountId: string;
  subAccountId: string | null;
  businessRatio: number;
  basis: string;
  changeReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 地代家賃の内訳の1行（§1.3） */
export type RentDetail = {
  id: string;
  fiscalYear: number;
  payee: string;
  property: string;
  annualRent: number;
  deductibleAmount: number;
  sortOrder: number;
};

/** 固定資産台帳の1行（§1.4） */
export type FixedAsset = {
  id: string;
  name: string;
  quantity: string | null;
  acquiredOn: string;
  acquisitionCost: number;
  method: DepreciationMethod;
  usefulLifeYears: number | null;
  /** 事業の用に供した日（009）。null なら取得日 */
  inServiceOn: string | null;
  /** 前年までの償却累計額（009） */
  priorAccumulated: number;
  /** 累計が何年分までか（009）。`priorAccumulated > 0` なら非 null */
  priorThroughYear: number | null;
  businessRatio: number;
  assetAccountId: string;
  linkedJournalId: string | null;
  note: string | null;
  disposedOn: string | null;
  /** 除却の種類（009）。`disposedOn` が null ⇔ null */
  disposalKind: "scrap" | "sale" | null;
  createdAt: string;
  updatedAt: string;
};

/** 定額法の償却率の表の 1 行（009 data-model §1.1。千分率） */
export type StraightLineRate = {
  usefulLifeYears: number;
  ratePermille: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceUrl: string;
};

/** 繰延資産（開業費）（009 data-model §1.4） */
export type DeferredAsset = {
  id: string;
  name: string;
  totalAmount: number;
  openedOn: string;
  priorAccumulated: number;
  priorThroughYear: number | null;
  accountId: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 開業費の年度ごとの償却額の決定（009 data-model §1.5） */
export type DeferredAmortization = {
  deferredAssetId: string;
  fiscalYear: number;
  amount: number;
  decidedAt: string;
  updatedAt: string;
};

/** 年度の開業費の償却の見え方（導出。009 data-model §2.1）。openingBalance は決定の上限 */
export type DeferredAmortizationView = {
  fiscalYear: number;
  openingBalance: number;
  /** 目安 */
  target: number;
  decision: DeferredAmortization | null;
  registered: boolean;
  closingBalance: number;
};

/**
 * 決算整理の仕訳の出所（§1.5）。kind = home_use なら allocationId、depreciation なら assetId、
 * deferred_amortization なら deferredAssetId が入る
 */
export type AdjustmentRef = {
  journalId: string;
  kind: AdjustmentKind;
  allocationId: string | null;
  assetId: string | null;
  deferredAssetId: string | null;
  fiscalYear: number;
};

/** 控除の要件の回答（§1.6） */
export type DeductionAnswers = {
  fiscalYear: number;
  doubleEntry: boolean;
  statementsAttached: boolean;
  filedOnTime: boolean;
  eTax: boolean;
  electronicBooks: boolean;
  updatedAt: string;
};

/** 決算のメモ（§1.7） */
export type ClosingNote = {
  fiscalYear: number;
  kind: ClosingNoteKind;
  body: string;
  updatedAt: string;
};

export type ClosingAuditTargetType =
  | "home_use_allocation"
  | "rent_detail"
  | "fixed_asset"
  | "blue_deduction_answer"
  | "closing_note"
  | "account_report_line"
  | "deferred_asset"
  | "deferred_amortization";

export type ClosingAuditAction = "create" | "update" | "dispose" | "delete";

/** 決算の設定の変更履歴（§1.10） */
export type ClosingAuditEntry = AuditEntry<ClosingAuditTargetType, ClosingAuditAction>;

// ---- 請求・定期仕訳（005） ----

export type InvoicingAuditTargetType =
  | "invoice_settings"
  | "billing_terms"
  | "work_hours"
  | "invoice"
  | "payment"
  | "recurring_journal"
  | "recurring_run";

export type InvoicingAuditAction =
  | "create"
  | "update"
  | "void"
  | "pause"
  | "resume"
  | "skip"
  | "acknowledge";

/** 請求・定期仕訳の操作の記録（`invoicing_audit_log`。追記のみ。data-model §1.10、R23） */
export type InvoicingAuditEntry = AuditEntry<InvoicingAuditTargetType, InvoicingAuditAction>;

// ---- 明細の取込と AI 仕訳（006） ----

export type StatementAuditTargetType =
  | "statement_batch"
  | "statement"
  | "statement_link"
  | "statement_account"
  | "inference_rule"
  | "statement_settings"
  | "statement_source";

export type StatementAuditAction =
  | "create"
  | "update"
  | "exclude"
  | "unexclude"
  | "acknowledge"
  | "unlink"
  | "revoke"
  | "pause"
  | "resume"
  | "edit"
  | "seed"
  | "delete";

/** 明細の取込・承認などの操作の記録（`statement_audit_log`。追記のみ。006 data-model §1.10、R18） */
export type StatementAuditEntry = AuditEntry<StatementAuditTargetType, StatementAuditAction>;

/** 取り込んだ明細（`statements` の 1 行。006 data-model §1.3）。金額は符号つき（入金が正） */
export type StatementRecord = {
  id: string;
  batchId: string;
  statementAccountId: string;
  stableKey: string;
  externalId: string | null;
  date: string;
  amount: number;
  content: string;
  normalizedContent: string;
  categoryMajor: string | null;
  categoryMinor: string | null;
  memo: string | null;
  transferFlag: boolean;
  /** `external_id` が同じで内容が違う取込があったときの新しい内容（JSON。FR-005） */
  changedJson: string | null;
  changedAckAt: string | null;
  excludedAt: string | null;
  excludedReason: string | null;
  createdAt: string;
};

/**
 * 明細の候補（`statement_candidates` の 1 行。006 data-model §1.4）。明細ごとに高々 1 件で、作り直しで置き換える。
 * `none` は purpose・confidence・draftJson が null。`match` の draftJson は `{ journalId, lineId }`、
 * ほかは仕訳の案（`JournalDraft` の JSON）
 */
export type StatementCandidateRecord = {
  statementId: string;
  method: CandidateMethod;
  purpose: Purpose | null;
  confidence: number | null;
  reason: string;
  draftJson: string | null;
  ruleId: string | null;
  model: string | null;
  createdAt: string;
};

/** 明細と仕訳の行の結びつき（`statement_links` の 1 行。006 data-model §1.5）。`revokedAt` が null のものが有効 */
export type StatementLinkRecord = {
  id: string;
  statementId: string;
  journalId: string;
  journalLineId: string;
  kind: StatementLinkKind;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
};

/** 推定のルール（`inference_rules` の 1 行。006 data-model §1.6、R9）。`statementAccountId` が null ならすべての口座 */
export type InferenceRule = {
  id: string;
  normalizedContent: string;
  statementAccountId: string | null;
  counterAccountId: string;
  counterSubAccountId: string | null;
  partnerId: string | null;
  taxCategory: TaxCategoryCode;
  purpose: Purpose;
  descriptionTemplate: string | null;
  hits: number;
  overrides: number;
  status: RuleStatus;
  origin: RuleOrigin;
  /** `user` は利用者が直した・止めたルール。承認の学びと初期作成は変えない（011 R9・INV-71） */
  managedBy: RuleManagedBy;
  createdAt: string;
  updatedAt: string;
};

/** ルールの履歴（`inference_rule_history` の 1 行。追記のみ。§1.7）。before・after はルールの JSON */
export type InferenceRuleHistoryRecord = {
  id: string;
  ruleId: string;
  action: RuleHistoryAction;
  beforeJson: string | null;
  afterJson: string | null;
  /** 承認が起点のとき */
  statementId: string | null;
  at: string;
};

/**
 * 定期仕訳の回（`recurring_runs` の 1 行。data-model §1.9）。`posted` は仕訳を持ち、`skipped` は理由を持つ。
 * 登録できない回（`blocked`）は保存しない（R17）
 */
export type RecurringRunRecord = {
  id: string;
  recurringId: string;
  /** `YYYY-MM` */
  targetMonth: string;
  status: "posted" | "skipped";
  journalId: string | null;
  skipReason: string | null;
  createdAt: string;
  /** 利用者が確かめた時刻（NULL から一度だけ書く。R21） */
  acknowledgedAt: string | null;
};

/** 工数（`work_hours` の 1 行）。`halfHours` は半時間の整数（0.5 時間 = 1。R7） */
export type WorkHoursRow = {
  partnerId: string;
  targetMonth: string;
  halfHours: number;
  updatedAt: string;
};

/** 発行済みの請求書（`invoices` の 1 行。写しの列は発行後に変えない。INV-38） */
export type InvoiceRecord = {
  id: string;
  invoiceNo: string;
  seq: number;
  partnerId: string;
  targetMonth: string;
  issueDate: string;
  salesDate: string;
  dueDate: string;
  recipientName: string;
  recipientHonorific: Honorific;
  issuer: InvoiceIssuer;
  priceMode?: InvoicePriceMode | undefined;
  taxDisplay: InvoiceTaxDisplay;
  total: number;
  /** 発行時に固定する源泉徴収の対象額と税額（013）。設定「なし」は 0・0 */
  withholdingBase: number;
  withholdingTax: number;
  journalId: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidJournalId: string | null;
};

/** 請求書の明細（`invoice_items` の 1 行。発行後は更新・削除できない） */
export type InvoiceItemRecord = {
  id: string;
  invoiceId: string;
  lineNo: number;
  name: string;
  /** 数量 × 2（半単位の整数）。数量がなければ null */
  quantityHalves: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number;
  taxCategory: TaxCategoryCode;
  /** 請求に使う税率（%）。免税の消費税相当額も含む。税率なしは null */
  taxRate: number | null;
};

/** 入金の消し込み（`invoice_payments` の 1 行）。取消は `voidedAt` で持つ */
export type PaymentRecord = PaymentView & { invoiceId: string; createdAt: string };

// ---- 証憑（010-receipts。data-model §1 の各表に対応する） ----

/** 証憑（`receipts` の 1 行。data-model §1.1）。`partnerKey` は `normalizeReceiptText(partnerName)`（R4） */
export type ReceiptRow = {
  id: string;
  /** アプリが最初のファイルを受け取った日時。変えない */
  receivedAt: string;
  channel: ReceiptChannel;
  category: ReceiptCategory;
  /** 今の版のファイルの SHA-256（R7） */
  currentSha256: string;
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  partnerKey: string | null;
  memo: string | null;
  deletedAt: string | null;
  deletedReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** 証憑のファイルの版（`receipt_files` の 1 行。不変。data-model §1.2） */
export type ReceiptFileRow = {
  sha256: string;
  receiptId: string;
  fileVersion: number;
  mediaType: ReceiptMediaType;
  sizeBytes: number;
  originalName: string;
  width: number | null;
  height: number | null;
  fullColor: boolean | null;
  addedAt: string;
  channel: ReceiptChannel;
};

/** 証憑と仕訳の結びつき（`receipt_links` の 1 行。有効 = `unlinkedAt` が null。data-model §1.3） */
export type ReceiptLinkRow = {
  id: string;
  receiptId: string;
  journalId: string;
  linkedAt: string;
  unlinkedAt: string | null;
  unlinkReason: string | null;
};

/**
 * 外部の AI の読み取りの記録（`receipt_readings` の 1 行。data-model §1.4）。
 * 画像・応答の本文・`reason` は持たない。値の比べ（`*Match`・`comparedAt`）は列ごとに NULL から 1 回だけ書く
 */
export type ReceiptReadingRow = {
  id: string;
  receiptId: string;
  fileSha256: string;
  readAt: string;
  model: string;
  status: ReceiptReadingStatus;
  errorCode: string | null;
  candDate: string | null;
  candAmount: number | null;
  candPartner: string | null;
  candAccountCode: string | null;
  candTaxCategory: TaxCategoryCode | null;
  confidence: number | null;
  comparedAt: string | null;
  dateMatch: boolean | null;
  amountMatch: boolean | null;
  partnerMatch: boolean | null;
  accountMatch: boolean | null;
  taxMatch: boolean | null;
};

/** `setReadingOutcome` が書く値の比べ。渡した列のうち NULL のものだけに書く（L2）。`comparedAt` は引数 `at` */
export type ReadingOutcome = {
  dateMatch: boolean;
  amountMatch: boolean;
  partnerMatch: boolean;
  accountMatch: boolean;
  taxMatch: boolean;
};

/** `ReceiptStore.search` の 1 行。今の版のファイルと、有効な結びつき・その仕訳（状態の導出に使う） */
export type ReceiptSearchRow = {
  receipt: ReceiptRow;
  currentFile: ReceiptFileRow;
  link: ReceiptLinkRow | undefined;
  journal: JournalRef | undefined;
};

export type ReceiptAuditTargetType = "receipt" | "receipt_link" | "receipt_reading";

export type ReceiptAuditAction =
  | "create"
  | "update"
  | "replace_file"
  | "delete"
  | "link"
  | "unlink"
  | "read";

/** 証憑の履歴の 1 行（`receipt_audit_log`。追記のみ。data-model §1.5）。作るときは `auditEntry` を使う */
export type ReceiptAuditEntry = AuditEntry<ReceiptAuditTargetType, ReceiptAuditAction>;
