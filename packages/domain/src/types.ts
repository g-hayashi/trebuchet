import type {
  AccountCategory,
  AccountingMethod,
  EntityKind,
  ErrorCode,
  ErrorDetails,
  ReportSection,
  Side,
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
export type JournalSource = "manual";

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

/** 帳票の集計に使う、有効な仕訳の行（仕訳の情報つき） */
export type PostedLine = {
  journalId: string;
  journalNo: number;
  date: string;
  memo: string | null;
  lineNo: number;
  side: Side;
  accountId: string;
  subAccountId: string | null;
  amount: number;
  taxCategory: TaxCategoryCode;
  taxAmount: number;
  partnerId: string | null;
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

export type AuditEntry = {
  id: string;
  occurredAt: string;
  targetType: AuditTargetType;
  targetId: string;
  action: AuditAction;
  reason: string | null;
  beforeJson: string | null;
  afterJson: string | null;
};

// ---- 検索 ----

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
