CREATE TABLE `adjustment_journal_refs` (
	`journal_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`allocation_id` text,
	`asset_id` text,
	`fiscal_year` integer NOT NULL,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`allocation_id`) REFERENCES `home_use_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "adjustment_journal_refs_kind" CHECK("adjustment_journal_refs"."kind" IN ('home_use', 'depreciation')),
	CONSTRAINT "adjustment_journal_refs_source" CHECK(("adjustment_journal_refs"."kind" <> 'home_use' OR "adjustment_journal_refs"."allocation_id" IS NOT NULL) AND ("adjustment_journal_refs"."kind" <> 'depreciation' OR "adjustment_journal_refs"."asset_id" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX `adjustment_journal_refs_year` ON `adjustment_journal_refs` (`fiscal_year`);--> statement-breakpoint
CREATE TABLE `blue_deduction_answers` (
	`fiscal_year` integer PRIMARY KEY NOT NULL,
	`double_entry` integer NOT NULL,
	`statements_attached` integer NOT NULL,
	`filed_on_time` integer NOT NULL,
	`e_tax` integer NOT NULL,
	`electronic_books` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "blue_deduction_answers_flags" CHECK("blue_deduction_answers"."double_entry" IN (0, 1) AND "blue_deduction_answers"."statements_attached" IN (0, 1) AND "blue_deduction_answers"."filed_on_time" IN (0, 1) AND "blue_deduction_answers"."e_tax" IN (0, 1) AND "blue_deduction_answers"."electronic_books" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `closing_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "closing_audit_log_target_type" CHECK("closing_audit_log"."target_type" IN ('home_use_allocation', 'rent_detail', 'fixed_asset', 'blue_deduction_answer', 'closing_note', 'account_report_line')),
	CONSTRAINT "closing_audit_log_action" CHECK("closing_audit_log"."action" IN ('create', 'update', 'dispose', 'delete'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `closing_audit_log_target` ON `closing_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `closing_notes` (
	`fiscal_year` integer NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`fiscal_year`, `kind`),
	CONSTRAINT "closing_notes_kind" CHECK("closing_notes"."kind" IN ('special_circumstances', 'opening_difference'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `filed_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_year` integer NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`filed_on` text,
	`memo` text,
	CONSTRAINT "filed_documents_kind" CHECK("filed_documents"."kind" IN ('blue_return', 'tax_return', 'attachment', 'other'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `filed_documents_year` ON `filed_documents` (`fiscal_year`);--> statement-breakpoint
CREATE TABLE `fixed_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`quantity` text,
	`acquired_on` text NOT NULL,
	`acquisition_cost` integer NOT NULL,
	`method` text NOT NULL,
	`useful_life_years` integer,
	`business_ratio` integer NOT NULL,
	`asset_account_id` text NOT NULL,
	`linked_journal_id` text,
	`note` text,
	`disposed_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`asset_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fixed_assets_name" CHECK(length("fixed_assets"."name") > 0),
	CONSTRAINT "fixed_assets_cost" CHECK("fixed_assets"."acquisition_cost" > 0),
	CONSTRAINT "fixed_assets_method" CHECK("fixed_assets"."method" IN ('small_asset_28_2')),
	CONSTRAINT "fixed_assets_ratio" CHECK("fixed_assets"."business_ratio" BETWEEN 0 AND 10000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `home_use_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_year` integer NOT NULL,
	`account_id` text NOT NULL,
	`sub_account_id` text,
	`business_ratio` integer NOT NULL,
	`basis` text NOT NULL,
	`change_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`fiscal_year`) REFERENCES `fiscal_periods`(`fiscal_year`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "home_use_allocations_ratio" CHECK("home_use_allocations"."business_ratio" BETWEEN 0 AND 10000),
	CONSTRAINT "home_use_allocations_basis" CHECK(length("home_use_allocations"."basis") > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `home_use_allocations_no_sub` ON `home_use_allocations` (`fiscal_year`,`account_id`) WHERE sub_account_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `home_use_allocations_key` ON `home_use_allocations` (`fiscal_year`,`account_id`,`sub_account_id`);--> statement-breakpoint
CREATE TABLE `rent_details` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_year` integer NOT NULL,
	`payee` text NOT NULL,
	`property` text NOT NULL,
	`annual_rent` integer NOT NULL,
	`deductible_amount` integer NOT NULL,
	`sort_order` integer NOT NULL,
	CONSTRAINT "rent_details_payee" CHECK(length("rent_details"."payee") > 0),
	CONSTRAINT "rent_details_property" CHECK(length("rent_details"."property") > 0),
	CONSTRAINT "rent_details_annual_rent" CHECK("rent_details"."annual_rent" >= 0),
	CONSTRAINT "rent_details_deductible" CHECK("rent_details"."deductible_amount" >= 0 AND "rent_details"."deductible_amount" <= "rent_details"."annual_rent")
) STRICT;
--> statement-breakpoint
CREATE INDEX `rent_details_year` ON `rent_details` (`fiscal_year`);--> statement-breakpoint
CREATE TABLE `tax_parameters` (
	`key` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`value` integer NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`key`, `effective_from`),
	CONSTRAINT "tax_parameters_key" CHECK("tax_parameters"."key" IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC')),
	CONSTRAINT "tax_parameters_value" CHECK("tax_parameters"."value" > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `tax_return_memos` (
	`id` text PRIMARY KEY NOT NULL,
	`fiscal_year` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`amount` integer,
	`file_path` text,
	`memo` text,
	CONSTRAINT "tax_return_memos_kind" CHECK("tax_return_memos"."kind" IN ('salary', 'social_insurance', 'small_business_mutual_aid', 'life_insurance', 'earthquake_insurance', 'donation', 'medical', 'stocks', 'crypto', 'foreign_tax_credit', 'other')),
	CONSTRAINT "tax_return_memos_amount" CHECK("tax_return_memos"."amount" IS NULL OR "tax_return_memos"."amount" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `tax_return_memos_year` ON `tax_return_memos` (`fiscal_year`);