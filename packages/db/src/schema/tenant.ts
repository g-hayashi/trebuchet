import {
  BILLING_TYPES,
  CANDIDATE_METHODS,
  JOURNAL_SOURCES,
  PURPOSES,
  ReceiptCategory,
  ReceiptChannel,
  ReceiptHistoryAction,
  ReceiptHistoryTargetType,
  ReceiptMediaType,
  ReceiptReadingStatus,
  RULE_HISTORY_ACTIONS,
  RULE_MANAGED_BY,
  RULE_ORIGINS,
  RULE_STATUSES,
  STATEMENT_ACCOUNT_KINDS,
  STATEMENT_ACCOUNT_USAGES,
  STATEMENT_LINK_KINDS,
  STATEMENT_ORIGINS,
} from "@trebuchet/schema";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// data-model.md §2〜§5。金額は INTEGER（円）、日付は TEXT（YYYY-MM-DD）、真偽値は INTEGER（0/1）

const bool = (name: string) => integer(name, { mode: "boolean" }).notNull();

/** 011/R6: 暗号化した事業体DBに、新規入力の状態だけを保存する。 */
export const journalDrafts = sqliteTable(
  "journal_drafts",
  {
    id: integer("id").primaryKey(),
    payload: text("payload").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [check("journal_drafts_singleton", sql`${t.id} = 1`)],
);

// ---- §2 マスタ ----

export const entityProfile = sqliteTable(
  "entity_profile",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["individual", "corporation"] }).notNull(),
    fiscalStartMonth: integer("fiscal_start_month").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("entity_profile_kind", sql`${t.kind} IN ('individual', 'corporation')`),
    check("entity_profile_month", sql`${t.fiscalStartMonth} BETWEEN 1 AND 12`),
  ],
);

export const fiscalPeriods = sqliteTable(
  "fiscal_periods",
  {
    id: text("id").primaryKey(),
    fiscalYear: integer("fiscal_year").notNull().unique(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [
    check("fiscal_periods_range", sql`${t.startDate} < ${t.endDate}`),
    check("fiscal_periods_status", sql`${t.status} IN ('open', 'closed')`),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull().unique(),
    category: text("category", {
      enum: ["asset", "liability", "equity", "revenue", "expense"],
    }).notNull(),
    normalSide: text("normal_side", { enum: ["debit", "credit"] }).notNull(),
    reportSection: text("report_section", {
      enum: [
        "PL_SALES",
        "PL_COGS",
        "PL_EXPENSE",
        "PL_OTHER",
        "BS_ASSET",
        "BS_LIABILITY",
        "BS_EQUITY",
      ],
    }).notNull(),
    reportLine: integer("report_line"),
    sortOrder: integer("sort_order").notNull(),
    isSystem: bool("is_system"),
    isActive: bool("is_active"),
  },
  (t) => [
    check(
      "accounts_category",
      sql`${t.category} IN ('asset', 'liability', 'equity', 'revenue', 'expense')`,
    ),
    check("accounts_normal_side", sql`${t.normalSide} IN ('debit', 'credit')`),
    check(
      "accounts_report_section",
      sql`${t.reportSection} IN ('PL_SALES', 'PL_COGS', 'PL_EXPENSE', 'PL_OTHER', 'BS_ASSET', 'BS_LIABILITY', 'BS_EQUITY')`,
    ),
  ],
);

export const subAccounts = sqliteTable(
  "sub_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    isActive: bool("is_active"),
  },
  (t) => [unique("sub_accounts_account_name").on(t.accountId, t.name)],
);

export const partners = sqliteTable(
  "partners",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    honorific: text("honorific", { enum: ["様", "御中"] }),
    memo: text("memo"),
    isActive: bool("is_active"),
  },
  (t) => [
    check("partners_honorific", sql`${t.honorific} IS NULL OR ${t.honorific} IN ('様', '御中')`),
  ],
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const taxCategories = sqliteTable(
  "tax_categories",
  {
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["sales", "purchase"] }),
  },
  (t) => [
    check("tax_categories_kind", sql`${t.kind} IS NULL OR ${t.kind} IN ('sales', 'purchase')`),
  ],
);

export const taxRates = sqliteTable(
  "tax_rates",
  {
    categoryCode: text("category_code")
      .notNull()
      .references(() => taxCategories.code),
    rate: integer("rate").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    sourceUrl: text("source_url").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.categoryCode, t.effectiveFrom] }),
    check("tax_rates_rate", sql`${t.rate} BETWEEN 0 AND 100`),
  ],
);

export const consumptionTaxSettings = sqliteTable(
  "consumption_tax_settings",
  {
    id: text("id").primaryKey(),
    effectiveFrom: text("effective_from").notNull().unique(),
    taxpayerStatus: text("taxpayer_status", {
      enum: ["exempt", "general", "simplified", "two_tenths"],
    }).notNull(),
    accountingMethod: text("accounting_method", {
      enum: ["tax_included", "tax_excluded"],
    }).notNull(),
  },
  (t) => [
    check(
      "consumption_tax_settings_status",
      sql`${t.taxpayerStatus} IN ('exempt', 'general', 'simplified', 'two_tenths')`,
    ),
    check(
      "consumption_tax_settings_method",
      sql`${t.accountingMethod} IN ('tax_included', 'tax_excluded')`,
    ),
  ],
);

// ---- §3 残高・仕訳 ----

export const openingBalances = sqliteTable(
  "opening_balances",
  {
    id: text("id").primaryKey(),
    fiscalPeriodId: text("fiscal_period_id")
      .notNull()
      .references(() => fiscalPeriods.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    side: text("side", { enum: ["debit", "credit"] }).notNull(),
    amount: integer("amount").notNull(),
  },
  (t) => [
    unique("opening_balances_key").on(t.fiscalPeriodId, t.accountId, t.subAccountId),
    check("opening_balances_side", sql`${t.side} IN ('debit', 'credit')`),
    check("opening_balances_amount", sql`${t.amount} > 0 AND ${t.amount} < 1000000000000`),
  ],
);

export const journals = sqliteTable(
  "journals",
  {
    id: text("id").primaryKey(),
    journalNo: integer("journal_no").notNull().unique(),
    date: text("date").notNull(),
    fiscalPeriodId: text("fiscal_period_id")
      .notNull()
      .references(() => fiscalPeriods.id),
    memo: text("memo"),
    status: text("status", { enum: ["active", "voided"] }).notNull(),
    correctsJournalId: text("corrects_journal_id").references((): AnySQLiteColumn => journals.id),
    source: text("source", { enum: JOURNAL_SOURCES }).notNull().default("manual"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("journals_date").on(t.date),
    check("journals_status", sql`${t.status} IN ('active', 'voided')`),
    check("journals_version", sql`${t.version} >= 1`),
  ],
);

export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: text("id").primaryKey(),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id),
    lineNo: integer("line_no").notNull(),
    side: text("side", { enum: ["debit", "credit"] }).notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category")
      .notNull()
      .references(() => taxCategories.code),
    taxAmount: integer("tax_amount").notNull(),
    partnerId: text("partner_id").references(() => partners.id),
    description: text("description"),
  },
  (t) => [
    unique("journal_lines_journal_line_no").on(t.journalId, t.lineNo),
    index("journal_lines_account").on(t.accountId),
    index("journal_lines_partner").on(t.partnerId),
    check("journal_lines_side", sql`${t.side} IN ('debit', 'credit')`),
    check("journal_lines_amount", sql`${t.amount} > 0 AND ${t.amount} < 1000000000000`),
    check("journal_lines_tax_amount", sql`${t.taxAmount} >= 0`),
  ],
);

export const journalLineTags = sqliteTable(
  "journal_line_tags",
  {
    journalLineId: text("journal_line_id")
      .notNull()
      .references(() => journalLines.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.journalLineId, t.tagId] })],
);

// ---- §5 監査 ----

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    targetType: text("target_type", {
      enum: ["journal", "account", "fiscal_period", "opening_balance", "tax_setting"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", {
      enum: ["create", "correct", "void", "rename", "deactivate", "close", "reopen", "replace"],
    }).notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("audit_log_target").on(t.targetType, t.targetId),
    check(
      "audit_log_target_type",
      sql`${t.targetType} IN ('journal', 'account', 'fiscal_period', 'opening_balance', 'tax_setting')`,
    ),
    check(
      "audit_log_action",
      sql`${t.action} IN ('create', 'correct', 'void', 'rename', 'deactivate', 'close', 'reopen', 'replace')`,
    ),
  ],
);

// ---- 002-freee-import（specs/002-freee-import/data-model.md §2） ----

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: ["freee_journal"] }).notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    importedAt: text("imported_at").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    fiscalYearsJson: text("fiscal_years_json").notNull(),
    countNew: integer("count_new").notNull(),
    countAlready: integer("count_already").notNull(),
    countExcluded: integer("count_excluded").notNull(),
    countRejected: integer("count_rejected").notNull(),
    countWarnings: integer("count_warnings").notNull(),
    status: text("status", { enum: ["active", "voided"] }).notNull(),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
  },
  (t) => [
    check("import_batches_source", sql`${t.source} IN ('freee_journal')`),
    check(
      "import_batches_sha256",
      sql`length(${t.fileSha256}) = 64 AND ${t.fileSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("import_batches_period", sql`${t.periodFrom} <= ${t.periodTo}`),
    check("import_batches_count_new", sql`${t.countNew} >= 1`),
    check(
      "import_batches_counts",
      sql`${t.countAlready} >= 0 AND ${t.countExcluded} >= 0 AND ${t.countRejected} >= 0 AND ${t.countWarnings} >= 0`,
    ),
    check("import_batches_status", sql`${t.status} IN ('active', 'voided')`),
    check(
      "import_batches_void",
      sql`${t.status} = 'active' OR (${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL)`,
    ),
  ],
);

export const importJournalRefs = sqliteTable(
  "import_journal_refs",
  {
    journalId: text("journal_id")
      .primaryKey()
      .references(() => journals.id),
    batchId: text("batch_id")
      .notNull()
      .references(() => importBatches.id),
    freeeJournalId: text("freee_journal_id").notNull(),
    freeeJournalNo: text("freee_journal_no"),
    freeeDate: text("freee_date").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    // INV-12: 取り消されていない参照の中で、freee の仕訳ID は一意
    uniqueIndex("import_journal_refs_active_freee_id")
      .on(t.freeeJournalId)
      .where(sql`revoked_at IS NULL`),
    index("import_journal_refs_batch").on(t.batchId),
    index("import_journal_refs_freee_date").on(t.freeeDate),
  ],
);

export const importAccountMappings = sqliteTable(
  "import_account_mappings",
  {
    sourceName: text("source_name").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    subAccountName: text("sub_account_name"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "import_account_mappings_sub_account",
      sql`${t.subAccountId} IS NULL OR ${t.subAccountName} IS NULL`,
    ),
  ],
);

export const importTaxMappings = sqliteTable("import_tax_mappings", {
  sourceName: text("source_name").primaryKey(),
  taxCategory: text("tax_category")
    .notNull()
    .references(() => taxCategories.code),
  updatedAt: text("updated_at").notNull(),
});

// ---- 003-tax-return（specs/003-tax-return/data-model.md §1） ----

export const taxParameters = sqliteTable(
  "tax_parameters",
  {
    key: text("key", {
      enum: [
        "SMALL_ASSET_THRESHOLD",
        "SMALL_ASSET_ANNUAL_LIMIT",
        "BLUE_DEDUCTION_MAX",
        "BLUE_DEDUCTION_STANDARD",
        "BLUE_DEDUCTION_BASIC",
        "LUMP_SUM_COST_MIN",
        "LUMP_SUM_COST_MAX",
        "LUMP_SUM_YEARS",
        "OPENING_COST_AMORTIZATION_MONTHS",
        // 010: 証憑の電子保存の期間・画素数（data-model §1.6）
        "RECEIPT_INPUT_CYCLE_MONTHS",
        "RECEIPT_INPUT_GRACE_BUSINESS_DAYS",
        "RECEIPT_SCAN_MIN_LONG_PX",
        "RECEIPT_SCAN_MIN_SHORT_PX",
        // 013: 報酬・料金の源泉徴収（data-model §1.1）
        "WITHHOLDING_THRESHOLD",
        "WITHHOLDING_RATE_LOW",
        "WITHHOLDING_RATE_HIGH",
      ],
    }).notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    value: integer("value").notNull(),
    sourceUrl: text("source_url").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.effectiveFrom] }),
    check(
      "tax_parameters_key",
      sql`${t.key} IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC', 'LUMP_SUM_COST_MIN', 'LUMP_SUM_COST_MAX', 'LUMP_SUM_YEARS', 'OPENING_COST_AMORTIZATION_MONTHS', 'RECEIPT_INPUT_CYCLE_MONTHS', 'RECEIPT_INPUT_GRACE_BUSINESS_DAYS', 'RECEIPT_SCAN_MIN_LONG_PX', 'RECEIPT_SCAN_MIN_SHORT_PX', 'WITHHOLDING_THRESHOLD', 'WITHHOLDING_RATE_LOW', 'WITHHOLDING_RATE_HIGH')`,
    ),
    check("tax_parameters_value", sql`${t.value} > 0`),
  ],
);

// ---- 009-depreciation-deferred（specs/009-depreciation-deferred/data-model.md §1） ----

/** 定額法の償却率（千分率）。正本は domain の seed/depreciation-rates.ts。更新・削除しない */
export const straightLineRates = sqliteTable(
  "straight_line_rates",
  {
    usefulLifeYears: integer("useful_life_years").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    ratePermille: integer("rate_permille").notNull(),
    sourceUrl: text("source_url").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.usefulLifeYears, t.effectiveFrom] }),
    check("straight_line_rates_years", sql`${t.usefulLifeYears} BETWEEN 2 AND 50`),
    check("straight_line_rates_rate", sql`${t.ratePermille} BETWEEN 1 AND 1000`),
  ],
);

export const homeUseAllocations = sqliteTable(
  "home_use_allocations",
  {
    id: text("id").primaryKey(),
    fiscalYear: integer("fiscal_year")
      .notNull()
      .references(() => fiscalPeriods.fiscalYear),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    businessRatio: integer("business_ratio").notNull(),
    basis: text("basis").notNull(),
    changeReason: text("change_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("home_use_allocations_key").on(t.fiscalYear, t.accountId, t.subAccountId),
    // sub_account_id が NULL の行は UNIQUE で重複を防げない（NULL は互いに異なる）ため、部分インデックスで防ぐ
    uniqueIndex("home_use_allocations_no_sub")
      .on(t.fiscalYear, t.accountId)
      .where(sql`sub_account_id IS NULL`),
    check("home_use_allocations_ratio", sql`${t.businessRatio} BETWEEN 0 AND 10000`),
    check("home_use_allocations_basis", sql`length(${t.basis}) > 0`),
  ],
);

export const rentDetails = sqliteTable(
  "rent_details",
  {
    id: text("id").primaryKey(),
    fiscalYear: integer("fiscal_year").notNull(),
    payee: text("payee").notNull(),
    property: text("property").notNull(),
    annualRent: integer("annual_rent").notNull(),
    deductibleAmount: integer("deductible_amount").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [
    index("rent_details_year").on(t.fiscalYear),
    check("rent_details_payee", sql`length(${t.payee}) > 0`),
    check("rent_details_property", sql`length(${t.property}) > 0`),
    check("rent_details_annual_rent", sql`${t.annualRent} >= 0`),
    check(
      "rent_details_deductible",
      sql`${t.deductibleAmount} >= 0 AND ${t.deductibleAmount} <= ${t.annualRent}`,
    ),
  ],
);

export const fixedAssets = sqliteTable(
  "fixed_assets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    quantity: text("quantity"),
    acquiredOn: text("acquired_on").notNull(),
    acquisitionCost: integer("acquisition_cost").notNull(),
    method: text("method", {
      enum: ["small_asset_28_2", "straight_line", "lump_sum"],
    }).notNull(),
    usefulLifeYears: integer("useful_life_years"),
    businessRatio: integer("business_ratio").notNull(),
    assetAccountId: text("asset_account_id")
      .notNull()
      .references(() => accounts.id),
    linkedJournalId: text("linked_journal_id").references(() => journals.id),
    note: text("note"),
    disposedOn: text("disposed_on"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // 009（data-model §1.3）
    inServiceOn: text("in_service_on"),
    priorAccumulated: integer("prior_accumulated").notNull().default(0),
    priorThroughYear: integer("prior_through_year"),
    disposalKind: text("disposal_kind", { enum: ["scrap", "sale"] }),
  },
  (t) => [
    check("fixed_assets_name", sql`length(${t.name}) > 0`),
    check("fixed_assets_cost", sql`${t.acquisitionCost} > 0`),
    check(
      "fixed_assets_method",
      sql`${t.method} IN ('small_asset_28_2', 'straight_line', 'lump_sum')`,
    ),
    check("fixed_assets_ratio", sql`${t.businessRatio} BETWEEN 0 AND 10000`),
    check("fixed_assets_prior", sql`${t.priorAccumulated} >= 0`),
    check(
      "fixed_assets_prior_year",
      sql`${t.priorAccumulated} = 0 OR ${t.priorThroughYear} IS NOT NULL`,
    ),
    check(
      "fixed_assets_useful_life",
      sql`${t.method} <> 'straight_line' OR ${t.usefulLifeYears} IS NOT NULL`,
    ),
    check("fixed_assets_disposal_kind", sql`${t.disposalKind} IN ('scrap', 'sale')`),
    check(
      "fixed_assets_disposal_pair",
      sql`(${t.disposedOn} IS NULL) = (${t.disposalKind} IS NULL)`,
    ),
  ],
);

/** 繰延資産（開業費）（009 data-model §1.4）。物理削除しない */
export const deferredAssets = sqliteTable(
  "deferred_assets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    totalAmount: integer("total_amount").notNull(),
    openedOn: text("opened_on").notNull(),
    priorAccumulated: integer("prior_accumulated").notNull().default(0),
    priorThroughYear: integer("prior_through_year"),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("deferred_assets_name", sql`length(${t.name}) > 0`),
    check("deferred_assets_total", sql`${t.totalAmount} > 0`),
    check(
      "deferred_assets_prior",
      sql`${t.priorAccumulated} >= 0 AND ${t.priorAccumulated} <= ${t.totalAmount}`,
    ),
    check(
      "deferred_assets_prior_year",
      sql`${t.priorAccumulated} = 0 OR ${t.priorThroughYear} IS NOT NULL`,
    ),
  ],
);

/** 開業費の年度ごとの償却額の決定（009 data-model §1.5）。更新できる。削除はトリガーで禁止（0012） */
export const deferredAmortizations = sqliteTable(
  "deferred_amortizations",
  {
    deferredAssetId: text("deferred_asset_id")
      .notNull()
      .references(() => deferredAssets.id),
    fiscalYear: integer("fiscal_year")
      .notNull()
      .references(() => fiscalPeriods.fiscalYear),
    amount: integer("amount").notNull(),
    decidedAt: text("decided_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deferredAssetId, t.fiscalYear] }),
    check("deferred_amortizations_amount", sql`${t.amount} >= 0`),
  ],
);

export const adjustmentJournalRefs = sqliteTable(
  "adjustment_journal_refs",
  {
    journalId: text("journal_id")
      .primaryKey()
      .references(() => journals.id),
    kind: text("kind", { enum: ["home_use", "depreciation", "deferred_amortization"] }).notNull(),
    allocationId: text("allocation_id").references(() => homeUseAllocations.id),
    assetId: text("asset_id").references(() => fixedAssets.id),
    fiscalYear: integer("fiscal_year").notNull(),
    // 009（data-model §1.6）
    deferredAssetId: text("deferred_asset_id").references(() => deferredAssets.id),
  },
  (t) => [
    index("adjustment_journal_refs_year").on(t.fiscalYear),
    check(
      "adjustment_journal_refs_kind",
      sql`${t.kind} IN ('home_use', 'depreciation', 'deferred_amortization')`,
    ),
    check(
      "adjustment_journal_refs_source",
      sql`(${t.kind} <> 'home_use' OR ${t.allocationId} IS NOT NULL) AND (${t.kind} <> 'depreciation' OR ${t.assetId} IS NOT NULL) AND (${t.kind} <> 'deferred_amortization' OR ${t.deferredAssetId} IS NOT NULL)`,
    ),
  ],
);

export const blueDeductionAnswers = sqliteTable(
  "blue_deduction_answers",
  {
    fiscalYear: integer("fiscal_year").primaryKey(),
    doubleEntry: bool("double_entry"),
    statementsAttached: bool("statements_attached"),
    filedOnTime: bool("filed_on_time"),
    eTax: bool("e_tax"),
    electronicBooks: bool("electronic_books"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check(
      "blue_deduction_answers_flags",
      sql`${t.doubleEntry} IN (0, 1) AND ${t.statementsAttached} IN (0, 1) AND ${t.filedOnTime} IN (0, 1) AND ${t.eTax} IN (0, 1) AND ${t.electronicBooks} IN (0, 1)`,
    ),
  ],
);

export const closingNotes = sqliteTable(
  "closing_notes",
  {
    fiscalYear: integer("fiscal_year").notNull(),
    kind: text("kind", { enum: ["special_circumstances", "opening_difference"] }).notNull(),
    body: text("body").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fiscalYear, t.kind] }),
    check("closing_notes_kind", sql`${t.kind} IN ('special_circumstances', 'opening_difference')`),
  ],
);

export const closingAuditLog = sqliteTable(
  "closing_audit_log",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    targetType: text("target_type", {
      enum: [
        "home_use_allocation",
        "rent_detail",
        "fixed_asset",
        "blue_deduction_answer",
        "closing_note",
        "account_report_line",
        "deferred_asset",
        "deferred_amortization",
      ],
    }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", { enum: ["create", "update", "dispose", "delete"] }).notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("closing_audit_log_target").on(t.targetType, t.targetId),
    check(
      "closing_audit_log_target_type",
      sql`${t.targetType} IN ('home_use_allocation', 'rent_detail', 'fixed_asset', 'blue_deduction_answer', 'closing_note', 'account_report_line', 'deferred_asset', 'deferred_amortization')`,
    ),
    check(
      "closing_audit_log_action",
      sql`${t.action} IN ('create', 'update', 'dispose', 'delete')`,
    ),
  ],
);

// ---- 005-recurring-invoicing（specs/005-recurring-invoicing/data-model.md §1） ----

export const invoiceSettings = sqliteTable(
  "invoice_settings",
  {
    id: integer("id").primaryKey(),
    issuerName: text("issuer_name").notNull(),
    tradeName: text("trade_name"),
    address: text("address").notNull(),
    contact: text("contact").notNull(),
    bankAccount: text("bank_account").notNull(),
    registrationNumber: text("registration_number"),
    taxDisplay: text("tax_display", { enum: ["separate", "inclusive_only"] })
      .notNull()
      .default("inclusive_only"),
    nextSeq: integer("next_seq").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("invoice_settings_single", sql`${t.id} = 1`),
    check(
      "invoice_settings_registration",
      sql`${t.registrationNumber} GLOB 'T[0-9]*' AND length(${t.registrationNumber}) = 14`,
    ),
    check("invoice_settings_tax_display", sql`${t.taxDisplay} IN ('separate', 'inclusive_only')`),
    check("invoice_settings_next_seq", sql`${t.nextSeq} >= 1`),
  ],
);

export const partnerBillingTerms = sqliteTable(
  "partner_billing_terms",
  {
    partnerId: text("partner_id")
      .primaryKey()
      .references(() => partners.id),
    billingType: text("billing_type", { enum: BILLING_TYPES }).notNull(),
    priceMode: text("price_mode", { enum: ["inclusive", "exclusive"] })
      .notNull()
      .default("inclusive"),
    taxRate: integer("tax_rate").default(-1),
    // 013: 源泉徴収あり（0 か 1）。1 なら発行時に源泉徴収税額を計算する（data-model §1.2）
    withholding: integer("withholding", { mode: "boolean" }).notNull().default(false),
    unitPrice: integer("unit_price"),
    monthlyAmount: integer("monthly_amount"),
    dueMonthsAfter: integer("due_months_after").notNull().default(1),
    dueDay: integer("due_day").notNull().default(31),
    defaultItemName: text("default_item_name").notNull(),
    billingName: text("billing_name"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("partner_billing_terms_type", sql`${t.billingType} IN ('hourly', 'monthly')`),
    check("partner_billing_terms_price_mode", sql`${t.priceMode} IN ('inclusive', 'exclusive')`),
    check("partner_billing_terms_withholding", sql`${t.withholding} IN (0, 1)`),
    check(
      "partner_billing_terms_tax_rate",
      sql`${t.taxRate} IS NULL OR ${t.taxRate} IN (-1, 8, 10)`,
    ),
    check(
      "partner_billing_terms_amounts",
      sql`(${t.billingType} = 'hourly' AND ${t.unitPrice} IS NOT NULL AND ${t.unitPrice} > 0 AND ${t.monthlyAmount} IS NULL) OR (${t.billingType} = 'monthly' AND ${t.monthlyAmount} IS NOT NULL AND ${t.monthlyAmount} > 0 AND ${t.unitPrice} IS NULL)`,
    ),
    check("partner_billing_terms_due_months", sql`${t.dueMonthsAfter} BETWEEN 0 AND 12`),
    check("partner_billing_terms_due_day", sql`${t.dueDay} BETWEEN 1 AND 28 OR ${t.dueDay} = 31`),
    check("partner_billing_terms_item_name", sql`length(${t.defaultItemName}) > 0`),
  ],
);

export const workHours = sqliteTable(
  "work_hours",
  {
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id),
    targetMonth: text("target_month").notNull(),
    halfHours: integer("half_hours").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.partnerId, t.targetMonth] }),
    check("work_hours_month", sql`${t.targetMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check("work_hours_half_hours", sql`${t.halfHours} >= 0`),
  ],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    invoiceNo: text("invoice_no").notNull().unique(),
    seq: integer("seq").notNull().unique(),
    partnerId: text("partner_id")
      .notNull()
      .references(() => partners.id),
    targetMonth: text("target_month").notNull(),
    issueDate: text("issue_date").notNull(),
    salesDate: text("sales_date").notNull(),
    dueDate: text("due_date").notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientHonorific: text("recipient_honorific", { enum: ["様", "御中"] }).notNull(),
    issuerJson: text("issuer_json").notNull(),
    priceMode: text("price_mode", { enum: ["inclusive", "exclusive"] })
      .notNull()
      .default("inclusive"),
    taxDisplay: text("tax_display", { enum: ["separate", "inclusive_only"] }).notNull(),
    total: integer("total").notNull(),
    // 013: 発行時に固定する源泉徴収の対象額と税額。設定「なし」は 0・0（data-model §1.3）
    withholdingBase: integer("withholding_base").notNull().default(0),
    withholdingTax: integer("withholding_tax").notNull().default(0),
    journalId: text("journal_id")
      .notNull()
      .unique()
      .references(() => journals.id),
    createdAt: text("created_at").notNull(),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
    voidJournalId: text("void_journal_id").references(() => journals.id),
  },
  (t) => [
    index("invoices_partner_month").on(t.partnerId, t.targetMonth),
    index("invoices_due_date").on(t.dueDate),
    check("invoices_seq", sql`${t.seq} >= 1`),
    check("invoices_month", sql`${t.targetMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check("invoices_recipient_name", sql`length(${t.recipientName}) > 0`),
    check("invoices_honorific", sql`${t.recipientHonorific} IN ('様', '御中')`),
    check("invoices_tax_display", sql`${t.taxDisplay} IN ('separate', 'inclusive_only')`),
    check("invoices_price_mode", sql`${t.priceMode} IN ('inclusive', 'exclusive')`),
    check("invoices_total", sql`${t.total} > 0 AND ${t.total} < 1000000000000`),
    check(
      "invoices_withholding",
      sql`${t.withholdingTax} >= 0 AND ${t.withholdingTax} <= ${t.withholdingBase} AND ${t.withholdingBase} <= ${t.total}`,
    ),
    check("invoices_void", sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`),
  ],
);

export const invoiceItems = sqliteTable(
  "invoice_items",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    lineNo: integer("line_no").notNull(),
    name: text("name").notNull(),
    quantityHalves: integer("quantity_halves"),
    unit: text("unit"),
    unitPrice: integer("unit_price"),
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category")
      .notNull()
      .references(() => taxCategories.code),
    taxRate: integer("tax_rate"),
  },
  (t) => [
    unique("invoice_items_invoice_line").on(t.invoiceId, t.lineNo),
    check("invoice_items_line_no", sql`${t.lineNo} BETWEEN 1 AND 5`),
    check("invoice_items_name", sql`length(${t.name}) > 0`),
    check("invoice_items_quantity", sql`${t.quantityHalves} IS NULL OR ${t.quantityHalves} > 0`),
    check("invoice_items_unit_price", sql`${t.unitPrice} IS NULL OR ${t.unitPrice} > 0`),
    check("invoice_items_amount", sql`${t.amount} > 0 AND ${t.amount} < 1000000000000`),
    // 数量と単価がともにあれば amount = quantity_halves × unit_price / 2（SQLite の整数の除算 = 切り捨て）
    check(
      "invoice_items_amount_match",
      sql`${t.quantityHalves} IS NULL OR ${t.unitPrice} IS NULL OR ${t.amount} = (${t.quantityHalves} * ${t.unitPrice}) / 2`,
    ),
  ],
);

export const invoicePayments = sqliteTable(
  "invoice_payments",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    receivedOn: text("received_on").notNull(),
    amount: integer("amount").notNull(),
    feeAmount: integer("fee_amount").notNull(),
    // 013: 実際に差し引かれた源泉徴収税額（data-model §1.4）
    withholdingAmount: integer("withholding_amount").notNull().default(0),
    depositAccountId: text("deposit_account_id")
      .notNull()
      .references(() => accounts.id),
    depositSubAccountId: text("deposit_sub_account_id").references(() => subAccounts.id),
    journalId: text("journal_id")
      .notNull()
      .unique()
      .references(() => journals.id),
    createdAt: text("created_at").notNull(),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
    voidJournalId: text("void_journal_id").references(() => journals.id),
  },
  (t) => [
    index("invoice_payments_invoice").on(t.invoiceId),
    check("invoice_payments_amount", sql`${t.amount} > 0`),
    check("invoice_payments_fee", sql`${t.feeAmount} >= 0`),
    check("invoice_payments_withholding", sql`${t.withholdingAmount} >= 0`),
    check("invoice_payments_void", sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`),
  ],
);

export const recurringJournals = sqliteTable(
  "recurring_journals",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    memo: text("memo"),
    dayOfMonth: integer("day_of_month").notNull(),
    startMonth: text("start_month").notNull(),
    endMonth: text("end_month"),
    status: text("status", { enum: ["active", "paused"] }).notNull(),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("recurring_journals_name", sql`length(${t.name}) > 0`),
    check("recurring_journals_day", sql`${t.dayOfMonth} BETWEEN 1 AND 28 OR ${t.dayOfMonth} = 31`),
    check(
      "recurring_journals_start_month",
      sql`${t.startMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`,
    ),
    check(
      "recurring_journals_end_month",
      sql`${t.endMonth} IS NULL OR (${t.endMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND ${t.endMonth} >= ${t.startMonth})`,
    ),
    check("recurring_journals_status", sql`${t.status} IN ('active', 'paused')`),
    check("recurring_journals_version", sql`${t.version} >= 1`),
  ],
);

export const recurringJournalLines = sqliteTable(
  "recurring_journal_lines",
  {
    id: text("id").primaryKey(),
    recurringId: text("recurring_id")
      .notNull()
      .references(() => recurringJournals.id),
    lineNo: integer("line_no").notNull(),
    side: text("side", { enum: ["debit", "credit"] }).notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    amount: integer("amount").notNull(),
    taxCategory: text("tax_category").references(() => taxCategories.code),
    partnerId: text("partner_id").references(() => partners.id),
    description: text("description"),
  },
  (t) => [
    unique("recurring_journal_lines_line").on(t.recurringId, t.lineNo),
    check("recurring_journal_lines_side", sql`${t.side} IN ('debit', 'credit')`),
    check("recurring_journal_lines_amount", sql`${t.amount} > 0 AND ${t.amount} < 1000000000000`),
  ],
);

export const recurringRuns = sqliteTable(
  "recurring_runs",
  {
    id: text("id").primaryKey(),
    recurringId: text("recurring_id")
      .notNull()
      .references(() => recurringJournals.id),
    targetMonth: text("target_month").notNull(),
    status: text("status", { enum: ["posted", "skipped"] }).notNull(),
    journalId: text("journal_id")
      .unique()
      .references(() => journals.id),
    skipReason: text("skip_reason"),
    createdAt: text("created_at").notNull(),
    acknowledgedAt: text("acknowledged_at"),
  },
  (t) => [
    // INV-35: 各（定期仕訳, 月）の回は高々1件
    unique("recurring_runs_recurring_month").on(t.recurringId, t.targetMonth),
    check("recurring_runs_month", sql`${t.targetMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check("recurring_runs_status", sql`${t.status} IN ('posted', 'skipped')`),
    check(
      "recurring_runs_shape",
      sql`(${t.status} = 'posted' AND ${t.journalId} IS NOT NULL) OR (${t.status} = 'skipped' AND ${t.journalId} IS NULL AND ${t.skipReason} IS NOT NULL)`,
    ),
  ],
);

export const invoicingAuditLog = sqliteTable(
  "invoicing_audit_log",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    targetType: text("target_type", {
      enum: [
        "invoice_settings",
        "billing_terms",
        "work_hours",
        "invoice",
        "payment",
        "recurring_journal",
        "recurring_run",
      ],
    }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", {
      enum: ["create", "update", "void", "pause", "resume", "skip", "acknowledge"],
    }).notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("invoicing_audit_log_target").on(t.targetType, t.targetId),
    check(
      "invoicing_audit_log_target_type",
      sql`${t.targetType} IN ('invoice_settings', 'billing_terms', 'work_hours', 'invoice', 'payment', 'recurring_journal', 'recurring_run')`,
    ),
    check(
      "invoicing_audit_log_action",
      sql`${t.action} IN ('create', 'update', 'void', 'pause', 'resume', 'skip', 'acknowledge')`,
    ),
  ],
);

// ---- 006-mfme-ai-journal（specs/006-mfme-ai-journal/data-model.md §1） ----

const STATEMENT_AUDIT_TARGETS = [
  "statement_batch",
  "statement",
  "statement_link",
  "statement_account",
  "inference_rule",
  "statement_settings",
  "statement_source",
] as const;
const STATEMENT_AUDIT_ACTIONS = [
  "create",
  "update",
  "exclude",
  "unexclude",
  "acknowledge",
  "unlink",
  "revoke",
  "pause",
  "resume",
  "edit",
  "seed",
  "delete",
] as const;
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const statementAccounts = sqliteTable(
  "statement_accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    usage: text("usage", { enum: STATEMENT_ACCOUNT_USAGES }).notNull(),
    kind: text("kind", { enum: STATEMENT_ACCOUNT_KINDS }).notNull(),
    accountId: text("account_id").references(() => accounts.id),
    subAccountId: text("sub_account_id").references(() => subAccounts.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("statement_accounts_usage", sql`${t.usage} IN (${inList(STATEMENT_ACCOUNT_USAGES)})`),
    check("statement_accounts_kind", sql`${t.kind} IN (${inList(STATEMENT_ACCOUNT_KINDS)})`),
    check(
      "statement_accounts_account",
      sql`(${t.usage} = 'private' AND ${t.accountId} IS NULL AND ${t.subAccountId} IS NULL) OR (${t.usage} <> 'private' AND ${t.accountId} IS NOT NULL)`,
    ),
  ],
);

/** 取込元と列の対応（007 data-model §1.1）。帳簿の記録ではないので物理削除してよい（削除は statement_audit_log に残す） */
export const statementSources = sqliteTable(
  "statement_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    // 1 つの口座の取込元の口座の名前（外部キーにしない）。NULL はまとめの取込元
    fixedAccountName: text("fixed_account_name"),
    // 正規化した見出しのセルの JSON 配列。NULL は見出しなし
    headerSignature: text("header_signature"),
    mappingJson: text("mapping_json").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [check("statement_sources_name", sql`length(${t.name}) BETWEEN 1 AND 100`)],
);

export const statementBatches = sqliteTable(
  "statement_batches",
  {
    id: text("id").primaryKey(),
    origin: text("origin", { enum: STATEMENT_ORIGINS }).notNull(),
    // 使った取込元の名前の写し（取込元を後で消しても残る）。NULL は取込元を保存しなかった取込（007 data-model §1.2）
    sourceName: text("source_name"),
    inputSha256: text("input_sha256").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    countNew: integer("count_new").notNull(),
    countExisting: integer("count_existing").notNull(),
    countUnreadable: integer("count_unreadable").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("statement_batches_origin", sql`${t.origin} IN (${inList(STATEMENT_ORIGINS)})`),
    check("statement_batches_count_new", sql`${t.countNew} >= 0`),
    check("statement_batches_count_existing", sql`${t.countExisting} >= 0`),
    check("statement_batches_count_unreadable", sql`${t.countUnreadable} >= 0`),
  ],
);

export const statements = sqliteTable(
  "statements",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => statementBatches.id),
    statementAccountId: text("statement_account_id")
      .notNull()
      .references(() => statementAccounts.id),
    // INV-40: 事業体の中で重複しない
    stableKey: text("stable_key").notNull().unique(),
    externalId: text("external_id"),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    content: text("content").notNull(),
    normalizedContent: text("normalized_content").notNull(),
    categoryMajor: text("category_major"),
    categoryMinor: text("category_minor"),
    memo: text("memo"),
    transferFlag: integer("transfer_flag").notNull(),
    changedJson: text("changed_json"),
    changedAckAt: text("changed_ack_at"),
    excludedAt: text("excluded_at"),
    excludedReason: text("excluded_reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("statements_external_id").on(t.externalId).where(sql`external_id IS NOT NULL`),
    index("statements_account_date").on(t.statementAccountId, t.date),
    index("statements_batch").on(t.batchId),
    check("statements_amount", sql`abs(${t.amount}) < 1000000000000`),
    check("statements_transfer_flag", sql`${t.transferFlag} IN (0, 1)`),
  ],
);

export const statementCandidates = sqliteTable(
  "statement_candidates",
  {
    statementId: text("statement_id")
      .primaryKey()
      .references(() => statements.id),
    method: text("method", { enum: CANDIDATE_METHODS }).notNull(),
    purpose: text("purpose", { enum: PURPOSES }),
    confidence: integer("confidence"),
    reason: text("reason").notNull(),
    draftJson: text("draft_json"),
    ruleId: text("rule_id").references(() => inferenceRules.id),
    model: text("model"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("statement_candidates_method", sql`${t.method} IN (${inList(CANDIDATE_METHODS)})`),
    check("statement_candidates_purpose", sql`${t.purpose} IN (${inList(PURPOSES)})`),
    check("statement_candidates_confidence", sql`${t.confidence} BETWEEN 0 AND 100`),
    check(
      "statement_candidates_shape",
      sql`(${t.method} = 'none' AND ${t.purpose} IS NULL AND ${t.confidence} IS NULL AND ${t.draftJson} IS NULL) OR (${t.method} <> 'none' AND ${t.purpose} IS NOT NULL AND ${t.confidence} IS NOT NULL)`,
    ),
  ],
);

export const statementLinks = sqliteTable(
  "statement_links",
  {
    id: text("id").primaryKey(),
    statementId: text("statement_id")
      .notNull()
      .references(() => statements.id),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id),
    journalLineId: text("journal_line_id")
      .notNull()
      .references(() => journalLines.id),
    kind: text("kind", { enum: STATEMENT_LINK_KINDS }).notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    // INV-43: 有効な結びつきは、明細ごと・仕訳の行ごとに高々 1 件
    uniqueIndex("statement_links_active_statement")
      .on(t.statementId)
      .where(sql`revoked_at IS NULL`),
    uniqueIndex("statement_links_active_line").on(t.journalLineId).where(sql`revoked_at IS NULL`),
    index("statement_links_journal").on(t.journalId),
    check("statement_links_kind", sql`${t.kind} IN (${inList(STATEMENT_LINK_KINDS)})`),
  ],
);

export const inferenceRules = sqliteTable(
  "inference_rules",
  {
    id: text("id").primaryKey(),
    normalizedContent: text("normalized_content").notNull(),
    statementAccountId: text("statement_account_id").references(() => statementAccounts.id),
    counterAccountId: text("counter_account_id")
      .notNull()
      .references(() => accounts.id),
    counterSubAccountId: text("counter_sub_account_id").references(() => subAccounts.id),
    partnerId: text("partner_id").references(() => partners.id),
    taxCategory: text("tax_category")
      .notNull()
      .references(() => taxCategories.code),
    purpose: text("purpose", { enum: PURPOSES }).notNull(),
    descriptionTemplate: text("description_template"),
    hits: integer("hits").notNull().default(0),
    overrides: integer("overrides").notNull().default(0),
    status: text("status", { enum: RULE_STATUSES }).notNull(),
    origin: text("origin", { enum: RULE_ORIGINS }).notNull(),
    managedBy: text("managed_by", { enum: RULE_MANAGED_BY }).notNull().default("auto"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // UNIQUE（normalized_content, ifnull(statement_account_id, '')）は式のインデックスで、
    // drizzle-kit が出力できないため 0008_statements_integrity.sql に手書きする
    check("inference_rules_purpose", sql`${t.purpose} IN (${inList(PURPOSES)})`),
    check("inference_rules_status", sql`${t.status} IN (${inList(RULE_STATUSES)})`),
    check("inference_rules_origin", sql`${t.origin} IN (${inList(RULE_ORIGINS)})`),
    check("inference_rules_managed_by", sql`${t.managedBy} IN (${inList(RULE_MANAGED_BY)})`),
    check("inference_rules_hits", sql`${t.hits} >= 0`),
    check("inference_rules_overrides", sql`${t.overrides} >= 0`),
  ],
);

export const inferenceRuleHistory = sqliteTable(
  "inference_rule_history",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => inferenceRules.id),
    action: text("action", { enum: RULE_HISTORY_ACTIONS }).notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    statementId: text("statement_id").references(() => statements.id),
    at: text("at").notNull(),
  },
  (t) => [
    index("inference_rule_history_rule").on(t.ruleId),
    check("inference_rule_history_action", sql`${t.action} IN (${inList(RULE_HISTORY_ACTIONS)})`),
  ],
);

export const statementSettings = sqliteTable(
  "statement_settings",
  {
    id: integer("id").primaryKey(),
    bulkThreshold: integer("bulk_threshold").notNull().default(80),
    externalThreshold: integer("external_threshold").notNull().default(60),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("statement_settings_single", sql`${t.id} = 1`),
    check("statement_settings_bulk", sql`${t.bulkThreshold} BETWEEN 0 AND 100`),
    check("statement_settings_external", sql`${t.externalThreshold} BETWEEN 0 AND 100`),
  ],
);

export const statementAuditLog = sqliteTable(
  "statement_audit_log",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    targetType: text("target_type", { enum: STATEMENT_AUDIT_TARGETS }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", { enum: STATEMENT_AUDIT_ACTIONS }).notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("statement_audit_log_target").on(t.targetType, t.targetId),
    check(
      "statement_audit_log_target_type",
      sql`${t.targetType} IN (${inList(STATEMENT_AUDIT_TARGETS)})`,
    ),
    check("statement_audit_log_action", sql`${t.action} IN (${inList(STATEMENT_AUDIT_ACTIONS)})`),
  ],
);

// ---- 010-receipts（specs/010-receipts/data-model.md §1.1〜1.5） ----

/** Zod の enum を drizzle の `enum` の形（空でない配列）にする。値は schema の定数と同じ */
const enumValues = <T extends string>(zodEnum: { options: readonly T[] }) =>
  zodEnum.options as unknown as readonly [T, ...T[]];

const sha256Check = (column: AnySQLiteColumn) =>
  sql`length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;

/**
 * 証憑。`current_sha256` ⇔ `receipt_files.receipt_id` は循環した外部キー。どちらも
 * `DEFERRABLE INITIALLY DEFERRED` にする（drizzle-kit は出力しないので 0014_receipts.sql に手で書き足す。§1.1・§5）
 */
export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    receivedAt: text("received_at").notNull(),
    channel: text("channel", { enum: enumValues(ReceiptChannel) }).notNull(),
    category: text("category", { enum: enumValues(ReceiptCategory) }).notNull(),
    currentSha256: text("current_sha256")
      .notNull()
      .references((): AnySQLiteColumn => receiptFiles.sha256),
    transactionDate: text("transaction_date"),
    amount: integer("amount"),
    partnerName: text("partner_name"),
    partnerKey: text("partner_key"),
    memo: text("memo"),
    deletedAt: text("deleted_at"),
    deletedReason: text("deleted_reason"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("receipts_search_date").on(t.deletedAt, t.transactionDate),
    index("receipts_amount").on(t.amount),
    index("receipts_received").on(t.receivedAt, t.id),
    check("receipts_channel", sql`${t.channel} IN (${inList(ReceiptChannel.options)})`),
    check("receipts_category", sql`${t.category} IN (${inList(ReceiptCategory.options)})`),
    check(
      "receipts_amount_range",
      sql`${t.amount} IS NULL OR (${t.amount} > 0 AND ${t.amount} < 1000000000000)`,
    ),
    check(
      "receipts_partner_name",
      sql`${t.partnerName} IS NULL OR (length(trim(${t.partnerName})) > 0 AND length(${t.partnerName}) <= 100)`,
    ),
    check("receipts_partner_key", sql`(${t.partnerName} IS NULL) = (${t.partnerKey} IS NULL)`),
    check("receipts_memo", sql`${t.memo} IS NULL OR length(${t.memo}) <= 500`),
    check("receipts_deleted", sql`(${t.deletedAt} IS NULL) = (${t.deletedReason} IS NULL)`),
    check("receipts_version", sql`${t.version} >= 1`),
  ],
);

/** 証憑のファイルの版。不変（UPDATE・DELETE はトリガーで禁止。0015） */
export const receiptFiles = sqliteTable(
  "receipt_files",
  {
    sha256: text("sha256").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references((): AnySQLiteColumn => receipts.id),
    fileVersion: integer("file_version").notNull(),
    mediaType: text("media_type", { enum: enumValues(ReceiptMediaType) }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    originalName: text("original_name").notNull(),
    width: integer("width"),
    height: integer("height"),
    fullColor: integer("full_color"),
    addedAt: text("added_at").notNull(),
    channel: text("channel", { enum: enumValues(ReceiptChannel) }).notNull(),
  },
  (t) => [
    unique("receipt_files_version").on(t.receiptId, t.fileVersion),
    check("receipt_files_sha256", sha256Check(t.sha256)),
    check("receipt_files_version_min", sql`${t.fileVersion} >= 1`),
    check("receipt_files_media_type", sql`${t.mediaType} IN (${inList(ReceiptMediaType.options)})`),
    check("receipt_files_size", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 20971520`),
    check("receipt_files_width", sql`${t.width} IS NULL OR ${t.width} > 0`),
    check("receipt_files_height", sql`${t.height} IS NULL OR ${t.height} > 0`),
    check("receipt_files_full_color", sql`${t.fullColor} IS NULL OR ${t.fullColor} IN (0, 1)`),
    check("receipt_files_channel", sql`${t.channel} IN (${inList(ReceiptChannel.options)})`),
  ],
);

/** 証憑と仕訳の結びつき。有効 = `unlinked_at IS NULL`（証憑ごとに高々 1 件。INV-64） */
export const receiptLinks = sqliteTable(
  "receipt_links",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    journalId: text("journal_id")
      .notNull()
      .references(() => journals.id),
    linkedAt: text("linked_at").notNull(),
    unlinkedAt: text("unlinked_at"),
    unlinkReason: text("unlink_reason"),
  },
  (t) => [
    uniqueIndex("receipt_links_active").on(t.receiptId).where(sql`unlinked_at IS NULL`),
    index("receipt_links_journal").on(t.journalId).where(sql`unlinked_at IS NULL`),
    check("receipt_links_unlinked", sql`(${t.unlinkedAt} IS NULL) = (${t.unlinkReason} IS NULL)`),
  ],
);

/** 外部の AI の読み取りの記録。画像・応答の本文・reason は持たない（R14） */
export const receiptReadings = sqliteTable(
  "receipt_readings",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    fileSha256: text("file_sha256")
      .notNull()
      .references(() => receiptFiles.sha256),
    readAt: text("read_at").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: enumValues(ReceiptReadingStatus) }).notNull(),
    errorCode: text("error_code"),
    candDate: text("cand_date"),
    candAmount: integer("cand_amount"),
    candPartner: text("cand_partner"),
    candAccountCode: text("cand_account_code"),
    candTaxCategory: text("cand_tax_category"),
    confidence: integer("confidence"),
    comparedAt: text("compared_at"),
    dateMatch: integer("date_match"),
    amountMatch: integer("amount_match"),
    partnerMatch: integer("partner_match"),
    accountMatch: integer("account_match"),
    taxMatch: integer("tax_match"),
  },
  (t) => [
    index("receipt_readings_receipt").on(t.receiptId),
    check("receipt_readings_status", sql`${t.status} IN (${inList(ReceiptReadingStatus.options)})`),
    check("receipt_readings_error_code", sql`${t.status} <> 'succeeded' OR ${t.errorCode} IS NULL`),
    check(
      "receipt_readings_candidates",
      sql`${t.status} = 'succeeded' OR (${t.candDate} IS NULL AND ${t.candAmount} IS NULL AND ${t.candPartner} IS NULL AND ${t.candAccountCode} IS NULL AND ${t.candTaxCategory} IS NULL AND ${t.confidence} IS NULL)`,
    ),
    check(
      "receipt_readings_confidence",
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 100`,
    ),
    check(
      "receipt_readings_matches",
      sql`(${t.dateMatch} IS NULL OR ${t.dateMatch} IN (0, 1)) AND (${t.amountMatch} IS NULL OR ${t.amountMatch} IN (0, 1)) AND (${t.partnerMatch} IS NULL OR ${t.partnerMatch} IN (0, 1)) AND (${t.accountMatch} IS NULL OR ${t.accountMatch} IN (0, 1)) AND (${t.taxMatch} IS NULL OR ${t.taxMatch} IN (0, 1))`,
    ),
  ],
);

/**
 * 証憑の履歴（追記のみ）。`receipt_id` は記録の対象の証憑（`target_type = 'receipt'` なら `target_id` と同じ。
 * 結びつき・読み取りの記録は `target_id` がその行の ID なので、証憑の ID で引けるように持つ。§1.5・§2.5）
 */
export const receiptAuditLog = sqliteTable(
  "receipt_audit_log",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id),
    targetType: text("target_type", { enum: enumValues(ReceiptHistoryTargetType) }).notNull(),
    targetId: text("target_id").notNull(),
    action: text("action", { enum: enumValues(ReceiptHistoryAction) }).notNull(),
    reason: text("reason"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [
    index("receipt_audit_log_target").on(t.targetType, t.targetId),
    index("receipt_audit_log_receipt").on(t.receiptId, t.occurredAt),
    check(
      "receipt_audit_log_target_type",
      sql`${t.targetType} IN (${inList(ReceiptHistoryTargetType.options)})`,
    ),
    check(
      "receipt_audit_log_action",
      sql`${t.action} IN (${inList(ReceiptHistoryAction.options)})`,
    ),
  ],
);
