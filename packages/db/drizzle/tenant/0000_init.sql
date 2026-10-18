CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`normal_side` text NOT NULL,
	`report_section` text NOT NULL,
	`report_line` integer,
	`sort_order` integer NOT NULL,
	`is_system` integer NOT NULL,
	`is_active` integer NOT NULL,
	CONSTRAINT "accounts_category" CHECK("accounts"."category" IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
	CONSTRAINT "accounts_normal_side" CHECK("accounts"."normal_side" IN ('debit', 'credit')),
	CONSTRAINT "accounts_report_section" CHECK("accounts"."report_section" IN ('PL_SALES', 'PL_COGS', 'PL_EXPENSE', 'PL_OTHER', 'BS_ASSET', 'BS_LIABILITY', 'BS_EQUITY'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_code_unique` ON `accounts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "audit_log_target_type" CHECK("audit_log"."target_type" IN ('journal', 'account', 'fiscal_period', 'opening_balance', 'tax_setting')),
	CONSTRAINT "audit_log_action" CHECK("audit_log"."action" IN ('create', 'correct', 'void', 'rename', 'deactivate', 'close', 'reopen', 'replace'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `audit_log_target` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `consumption_tax_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`effective_from` text NOT NULL,
	`taxpayer_status` text NOT NULL,
	`accounting_method` text NOT NULL,
	CONSTRAINT "consumption_tax_settings_status" CHECK("consumption_tax_settings"."taxpayer_status" IN ('exempt', 'general', 'simplified', 'two_tenths')),
	CONSTRAINT "consumption_tax_settings_method" CHECK("consumption_tax_settings"."accounting_method" IN ('tax_included', 'tax_excluded'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `consumption_tax_settings_effective_from_unique` ON `consumption_tax_settings` (`effective_from`);--> statement-breakpoint
CREATE TABLE `entity_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`fiscal_start_month` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "entity_profile_kind" CHECK("entity_profile"."kind" IN ('individual', 'corporation')),
	CONSTRAINT "entity_profile_month" CHECK("entity_profile"."fiscal_start_month" BETWEEN 1 AND 12)
) STRICT;
--> statement-breakpoint
CREATE TABLE `fiscal_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_year` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text NOT NULL,
	`closed_at` text,
	CONSTRAINT "fiscal_periods_range" CHECK("fiscal_periods"."start_date" < "fiscal_periods"."end_date"),
	CONSTRAINT "fiscal_periods_status" CHECK("fiscal_periods"."status" IN ('open', 'closed'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_periods_fiscal_year_unique` ON `fiscal_periods` (`fiscal_year`);--> statement-breakpoint
CREATE TABLE `journal_line_tags` (
	`journal_line_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`journal_line_id`, `tag_id`),
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`journal_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`side` text NOT NULL,
	`account_id` text NOT NULL,
	`sub_account_id` text,
	`amount` integer NOT NULL,
	`tax_category` text NOT NULL,
	`tax_amount` integer NOT NULL,
	`partner_id` text,
	`description` text,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_lines_side" CHECK("journal_lines"."side" IN ('debit', 'credit')),
	CONSTRAINT "journal_lines_amount" CHECK("journal_lines"."amount" > 0 AND "journal_lines"."amount" < 1000000000000),
	CONSTRAINT "journal_lines_tax_amount" CHECK("journal_lines"."tax_amount" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `journal_lines_account` ON `journal_lines` (`account_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_partner` ON `journal_lines` (`partner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `journal_lines_journal_line_no` ON `journal_lines` (`journal_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `journals` (
	`id` text PRIMARY KEY NOT NULL,
	`journal_no` integer NOT NULL,
	`date` text NOT NULL,
	`fiscal_period_id` text NOT NULL,
	`memo` text,
	`status` text NOT NULL,
	`corrects_journal_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`fiscal_period_id`) REFERENCES `fiscal_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`corrects_journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journals_status" CHECK("journals"."status" IN ('active', 'voided')),
	CONSTRAINT "journals_version" CHECK("journals"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `journals_journal_no_unique` ON `journals` (`journal_no`);--> statement-breakpoint
CREATE INDEX `journals_date` ON `journals` (`date`);--> statement-breakpoint
CREATE TABLE `opening_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_period_id` text NOT NULL,
	`account_id` text NOT NULL,
	`sub_account_id` text,
	`side` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`fiscal_period_id`) REFERENCES `fiscal_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "opening_balances_side" CHECK("opening_balances"."side" IN ('debit', 'credit')),
	CONSTRAINT "opening_balances_amount" CHECK("opening_balances"."amount" > 0 AND "opening_balances"."amount" < 1000000000000)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `opening_balances_key` ON `opening_balances` (`fiscal_period_id`,`account_id`,`sub_account_id`);--> statement-breakpoint
CREATE TABLE `partners` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`honorific` text,
	`memo` text,
	`is_active` integer NOT NULL,
	CONSTRAINT "partners_honorific" CHECK("partners"."honorific" IS NULL OR "partners"."honorific" IN ('様', '御中'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `partners_name_unique` ON `partners` (`name`);--> statement-breakpoint
CREATE TABLE `sub_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `sub_accounts_account_name` ON `sub_accounts` (`account_id`,`name`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `tax_categories` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	CONSTRAINT "tax_categories_kind" CHECK("tax_categories"."kind" IS NULL OR "tax_categories"."kind" IN ('sales', 'purchase'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`category_code` text NOT NULL,
	`rate` integer NOT NULL,
	`effective_from` text NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`category_code`, `effective_from`),
	FOREIGN KEY (`category_code`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tax_rates_rate" CHECK("tax_rates"."rate" BETWEEN 0 AND 100)
) STRICT;
