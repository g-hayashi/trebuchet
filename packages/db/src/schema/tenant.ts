import {
  BILLING_TYPES,
  CANDIDATE_METHODS,
  JOURNAL_SOURCES,
  PURPOSES,
  RULE_HISTORY_ACTIONS,
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
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // UNIQUE（normalized_content, ifnull(statement_account_id, '')）は式のインデックスで、
    // drizzle-kit が出力できないため 0008_statements_integrity.sql に手書きする
    check("inference_rules_purpose", sql`${t.purpose} IN (${inList(PURPOSES)})`),
    check("inference_rules_status", sql`${t.status} IN (${inList(RULE_STATUSES)})`),
    check("inference_rules_origin", sql`${t.origin} IN (${inList(RULE_ORIGINS)})`),
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

export const evalRuns = sqliteTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    splitDate: text("split_date").notNull(),
    includeAi: integer("include_ai").notNull(),
    sampleCount: integer("sample_count").notNull(),
    resultJson: text("result_json").notNull(),
    modelsJson: text("models_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("eval_runs_include_ai", sql`${t.includeAi} IN (0, 1)`),
    check("eval_runs_sample_count", sql`${t.sampleCount} >= 0`),
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
