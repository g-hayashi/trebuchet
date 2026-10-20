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
    source: text("source", { enum: ["manual", "import_freee"] })
      .notNull()
      .default("manual"),
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
      sql`${t.key} IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC')`,
    ),
    check("tax_parameters_value", sql`${t.value} > 0`),
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
    method: text("method", { enum: ["small_asset_28_2"] }).notNull(),
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
  },
  (t) => [
    check("fixed_assets_name", sql`length(${t.name}) > 0`),
    check("fixed_assets_cost", sql`${t.acquisitionCost} > 0`),
    check("fixed_assets_method", sql`${t.method} IN ('small_asset_28_2')`),
    check("fixed_assets_ratio", sql`${t.businessRatio} BETWEEN 0 AND 10000`),
  ],
);

export const adjustmentJournalRefs = sqliteTable(
  "adjustment_journal_refs",
  {
    journalId: text("journal_id")
      .primaryKey()
      .references(() => journals.id),
    kind: text("kind", { enum: ["home_use", "depreciation"] }).notNull(),
    allocationId: text("allocation_id").references(() => homeUseAllocations.id),
    assetId: text("asset_id").references(() => fixedAssets.id),
    fiscalYear: integer("fiscal_year").notNull(),
  },
  (t) => [
    index("adjustment_journal_refs_year").on(t.fiscalYear),
    check("adjustment_journal_refs_kind", sql`${t.kind} IN ('home_use', 'depreciation')`),
    check(
      "adjustment_journal_refs_source",
      sql`(${t.kind} <> 'home_use' OR ${t.allocationId} IS NOT NULL) AND (${t.kind} <> 'depreciation' OR ${t.assetId} IS NOT NULL)`,
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

export const taxReturnMemos = sqliteTable(
  "tax_return_memos",
  {
    id: text("id").primaryKey(),
    fiscalYear: integer("fiscal_year").notNull(),
    kind: text("kind", {
      enum: [
        "salary",
        "social_insurance",
        "small_business_mutual_aid",
        "life_insurance",
        "earthquake_insurance",
        "donation",
        "medical",
        "stocks",
        "crypto",
        "foreign_tax_credit",
        "other",
      ],
    }).notNull(),
    label: text("label"),
    amount: integer("amount"),
    filePath: text("file_path"),
    memo: text("memo"),
  },
  (t) => [
    index("tax_return_memos_year").on(t.fiscalYear),
    check(
      "tax_return_memos_kind",
      sql`${t.kind} IN ('salary', 'social_insurance', 'small_business_mutual_aid', 'life_insurance', 'earthquake_insurance', 'donation', 'medical', 'stocks', 'crypto', 'foreign_tax_credit', 'other')`,
    ),
    check("tax_return_memos_amount", sql`${t.amount} IS NULL OR ${t.amount} >= 0`),
  ],
);

export const filedDocuments = sqliteTable(
  "filed_documents",
  {
    id: text("id").primaryKey(),
    fiscalYear: integer("fiscal_year").notNull(),
    kind: text("kind", { enum: ["blue_return", "tax_return", "attachment", "other"] }).notNull(),
    filePath: text("file_path").notNull(),
    filedOn: text("filed_on"),
    memo: text("memo"),
  },
  (t) => [
    index("filed_documents_year").on(t.fiscalYear),
    check(
      "filed_documents_kind",
      sql`${t.kind} IN ('blue_return', 'tax_return', 'attachment', 'other')`,
    ),
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
      sql`${t.targetType} IN ('home_use_allocation', 'rent_detail', 'fixed_asset', 'blue_deduction_answer', 'closing_note', 'account_report_line')`,
    ),
    check(
      "closing_audit_log_action",
      sql`${t.action} IN ('create', 'update', 'dispose', 'delete')`,
    ),
  ],
);
