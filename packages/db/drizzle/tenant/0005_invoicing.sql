CREATE TABLE `invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`name` text NOT NULL,
	`quantity_halves` integer,
	`unit` text,
	`unit_price` integer,
	`amount` integer NOT NULL,
	`tax_category` text NOT NULL,
	`tax_rate` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_items_line_no" CHECK("invoice_items"."line_no" BETWEEN 1 AND 5),
	CONSTRAINT "invoice_items_name" CHECK(length("invoice_items"."name") > 0),
	CONSTRAINT "invoice_items_quantity" CHECK("invoice_items"."quantity_halves" IS NULL OR "invoice_items"."quantity_halves" > 0),
	CONSTRAINT "invoice_items_unit_price" CHECK("invoice_items"."unit_price" IS NULL OR "invoice_items"."unit_price" > 0),
	CONSTRAINT "invoice_items_amount" CHECK("invoice_items"."amount" > 0 AND "invoice_items"."amount" < 1000000000000),
	CONSTRAINT "invoice_items_amount_match" CHECK("invoice_items"."quantity_halves" IS NULL OR "invoice_items"."unit_price" IS NULL OR "invoice_items"."amount" = ("invoice_items"."quantity_halves" * "invoice_items"."unit_price") / 2)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_items_invoice_line` ON `invoice_items` (`invoice_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `invoice_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`received_on` text NOT NULL,
	`amount` integer NOT NULL,
	`fee_amount` integer NOT NULL,
	`deposit_account_id` text NOT NULL,
	`deposit_sub_account_id` text,
	`journal_id` text NOT NULL,
	`created_at` text NOT NULL,
	`voided_at` text,
	`void_reason` text,
	`void_journal_id` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`void_journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_payments_amount" CHECK("invoice_payments"."amount" > 0),
	CONSTRAINT "invoice_payments_fee" CHECK("invoice_payments"."fee_amount" >= 0),
	CONSTRAINT "invoice_payments_void" CHECK(("invoice_payments"."voided_at" IS NULL) = ("invoice_payments"."void_reason" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_payments_journal_id_unique` ON `invoice_payments` (`journal_id`);--> statement-breakpoint
CREATE INDEX `invoice_payments_invoice` ON `invoice_payments` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoice_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`issuer_name` text NOT NULL,
	`trade_name` text,
	`address` text NOT NULL,
	`contact` text NOT NULL,
	`bank_account` text NOT NULL,
	`registration_number` text,
	`tax_display` text DEFAULT 'inclusive_only' NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "invoice_settings_single" CHECK("invoice_settings"."id" = 1),
	CONSTRAINT "invoice_settings_registration" CHECK("invoice_settings"."registration_number" GLOB 'T[0-9]*' AND length("invoice_settings"."registration_number") = 14),
	CONSTRAINT "invoice_settings_tax_display" CHECK("invoice_settings"."tax_display" IN ('separate', 'inclusive_only')),
	CONSTRAINT "invoice_settings_next_seq" CHECK("invoice_settings"."next_seq" >= 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_no` text NOT NULL,
	`seq` integer NOT NULL,
	`partner_id` text NOT NULL,
	`target_month` text NOT NULL,
	`issue_date` text NOT NULL,
	`sales_date` text NOT NULL,
	`due_date` text NOT NULL,
	`recipient_name` text NOT NULL,
	`recipient_honorific` text NOT NULL,
	`issuer_json` text NOT NULL,
	`tax_display` text NOT NULL,
	`total` integer NOT NULL,
	`journal_id` text NOT NULL,
	`created_at` text NOT NULL,
	`voided_at` text,
	`void_reason` text,
	`void_journal_id` text,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`void_journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoices_seq" CHECK("invoices"."seq" >= 1),
	CONSTRAINT "invoices_month" CHECK("invoices"."target_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "invoices_recipient_name" CHECK(length("invoices"."recipient_name") > 0),
	CONSTRAINT "invoices_honorific" CHECK("invoices"."recipient_honorific" IN ('様', '御中')),
	CONSTRAINT "invoices_tax_display" CHECK("invoices"."tax_display" IN ('separate', 'inclusive_only')),
	CONSTRAINT "invoices_total" CHECK("invoices"."total" > 0 AND "invoices"."total" < 1000000000000),
	CONSTRAINT "invoices_void" CHECK(("invoices"."voided_at" IS NULL) = ("invoices"."void_reason" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_invoice_no_unique` ON `invoices` (`invoice_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_seq_unique` ON `invoices` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_journal_id_unique` ON `invoices` (`journal_id`);--> statement-breakpoint
CREATE INDEX `invoices_partner_month` ON `invoices` (`partner_id`,`target_month`);--> statement-breakpoint
CREATE INDEX `invoices_due_date` ON `invoices` (`due_date`);--> statement-breakpoint
CREATE TABLE `invoicing_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "invoicing_audit_log_target_type" CHECK("invoicing_audit_log"."target_type" IN ('invoice_settings', 'billing_terms', 'work_hours', 'invoice', 'payment', 'recurring_journal', 'recurring_run')),
	CONSTRAINT "invoicing_audit_log_action" CHECK("invoicing_audit_log"."action" IN ('create', 'update', 'void', 'pause', 'resume', 'skip', 'acknowledge'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `invoicing_audit_log_target` ON `invoicing_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `partner_billing_terms` (
	`partner_id` text PRIMARY KEY NOT NULL,
	`billing_type` text NOT NULL,
	`unit_price` integer,
	`monthly_amount` integer,
	`due_months_after` integer DEFAULT 1 NOT NULL,
	`due_day` integer DEFAULT 31 NOT NULL,
	`default_item_name` text NOT NULL,
	`billing_name` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "partner_billing_terms_type" CHECK("partner_billing_terms"."billing_type" IN ('hourly', 'monthly')),
	CONSTRAINT "partner_billing_terms_amounts" CHECK(("partner_billing_terms"."billing_type" = 'hourly' AND "partner_billing_terms"."unit_price" IS NOT NULL AND "partner_billing_terms"."unit_price" > 0 AND "partner_billing_terms"."monthly_amount" IS NULL) OR ("partner_billing_terms"."billing_type" = 'monthly' AND "partner_billing_terms"."monthly_amount" IS NOT NULL AND "partner_billing_terms"."monthly_amount" > 0 AND "partner_billing_terms"."unit_price" IS NULL)),
	CONSTRAINT "partner_billing_terms_due_months" CHECK("partner_billing_terms"."due_months_after" BETWEEN 0 AND 12),
	CONSTRAINT "partner_billing_terms_due_day" CHECK("partner_billing_terms"."due_day" BETWEEN 1 AND 28 OR "partner_billing_terms"."due_day" = 31),
	CONSTRAINT "partner_billing_terms_item_name" CHECK(length("partner_billing_terms"."default_item_name") > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `recurring_journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`side` text NOT NULL,
	`account_id` text NOT NULL,
	`sub_account_id` text,
	`amount` integer NOT NULL,
	`tax_category` text,
	`partner_id` text,
	`description` text,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_journal_lines_side" CHECK("recurring_journal_lines"."side" IN ('debit', 'credit')),
	CONSTRAINT "recurring_journal_lines_amount" CHECK("recurring_journal_lines"."amount" > 0 AND "recurring_journal_lines"."amount" < 1000000000000)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_journal_lines_line` ON `recurring_journal_lines` (`recurring_id`,`line_no`);--> statement-breakpoint
CREATE TABLE `recurring_journals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`memo` text,
	`day_of_month` integer NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "recurring_journals_name" CHECK(length("recurring_journals"."name") > 0),
	CONSTRAINT "recurring_journals_day" CHECK("recurring_journals"."day_of_month" BETWEEN 1 AND 28 OR "recurring_journals"."day_of_month" = 31),
	CONSTRAINT "recurring_journals_start_month" CHECK("recurring_journals"."start_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "recurring_journals_end_month" CHECK("recurring_journals"."end_month" IS NULL OR ("recurring_journals"."end_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND "recurring_journals"."end_month" >= "recurring_journals"."start_month")),
	CONSTRAINT "recurring_journals_status" CHECK("recurring_journals"."status" IN ('active', 'paused')),
	CONSTRAINT "recurring_journals_version" CHECK("recurring_journals"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `recurring_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`recurring_id` text NOT NULL,
	`target_month` text NOT NULL,
	`status` text NOT NULL,
	`journal_id` text,
	`skip_reason` text,
	`created_at` text NOT NULL,
	`acknowledged_at` text,
	FOREIGN KEY (`recurring_id`) REFERENCES `recurring_journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_runs_month" CHECK("recurring_runs"."target_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "recurring_runs_status" CHECK("recurring_runs"."status" IN ('posted', 'skipped')),
	CONSTRAINT "recurring_runs_shape" CHECK(("recurring_runs"."status" = 'posted' AND "recurring_runs"."journal_id" IS NOT NULL) OR ("recurring_runs"."status" = 'skipped' AND "recurring_runs"."journal_id" IS NULL AND "recurring_runs"."skip_reason" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_runs_journal_id_unique` ON `recurring_runs` (`journal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_runs_recurring_month` ON `recurring_runs` (`recurring_id`,`target_month`);--> statement-breakpoint
CREATE TABLE `work_hours` (
	`partner_id` text NOT NULL,
	`target_month` text NOT NULL,
	`half_hours` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`partner_id`, `target_month`),
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_hours_month" CHECK("work_hours"."target_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "work_hours_half_hours" CHECK("work_hours"."half_hours" >= 0)
) STRICT;
