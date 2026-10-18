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
    source: text("source", { enum: ["manual"] })
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
