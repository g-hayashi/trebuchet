-- 009-depreciation-deferred（data-model §1.1〜1.7、research R14）。drizzle-kit generate の出力を手で直した:
-- ・新しい表と作り直した表を STRICT にした（001/R2）
-- ・マイグレーションはトランザクションの中で走り、PRAGMA foreign_keys は効かない。fixed_assets は
--   adjustment_journal_refs が参照するので、PRAGMA defer_foreign_keys で検査をコミットまで遅らせ、
--   最終の名前の表を作って写す（RENAME は使わない。写しの INSERT が違反の数を戻す。0009 と同じ）
-- ・作り直した表の行は写す。新しい列は既定値・NULL で写す。disposed_on がある行の disposal_kind は 'scrap'（003 の除却）
-- ・作り直しで消える adjustment_journal_refs / closing_audit_log のトリガーは 0012 で作り直す
CREATE TABLE `straight_line_rates` (
	`useful_life_years` integer NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`rate_permille` integer NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`useful_life_years`, `effective_from`),
	CONSTRAINT "straight_line_rates_years" CHECK("straight_line_rates"."useful_life_years" BETWEEN 2 AND 50),
	CONSTRAINT "straight_line_rates_rate" CHECK("straight_line_rates"."rate_permille" BETWEEN 1 AND 1000)
) STRICT;
--> statement-breakpoint
CREATE TABLE `deferred_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`total_amount` integer NOT NULL,
	`opened_on` text NOT NULL,
	`prior_accumulated` integer DEFAULT 0 NOT NULL,
	`prior_through_year` integer,
	`account_id` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferred_assets_name" CHECK(length("deferred_assets"."name") > 0),
	CONSTRAINT "deferred_assets_total" CHECK("deferred_assets"."total_amount" > 0),
	CONSTRAINT "deferred_assets_prior" CHECK("deferred_assets"."prior_accumulated" >= 0 AND "deferred_assets"."prior_accumulated" <= "deferred_assets"."total_amount"),
	CONSTRAINT "deferred_assets_prior_year" CHECK("deferred_assets"."prior_accumulated" = 0 OR "deferred_assets"."prior_through_year" IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE `deferred_amortizations` (
	`deferred_asset_id` text NOT NULL,
	`fiscal_year` integer NOT NULL,
	`amount` integer NOT NULL,
	`decided_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`deferred_asset_id`, `fiscal_year`),
	FOREIGN KEY (`deferred_asset_id`) REFERENCES `deferred_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fiscal_year`) REFERENCES `fiscal_periods`(`fiscal_year`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deferred_amortizations_amount" CHECK("deferred_amortizations"."amount" >= 0)
) STRICT;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__old_tax_parameters` AS SELECT * FROM `tax_parameters`;--> statement-breakpoint
DROP TABLE `tax_parameters`;--> statement-breakpoint
CREATE TABLE `tax_parameters` (
	`key` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`value` integer NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`key`, `effective_from`),
	CONSTRAINT "tax_parameters_key" CHECK("tax_parameters"."key" IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC', 'LUMP_SUM_COST_MIN', 'LUMP_SUM_COST_MAX', 'LUMP_SUM_YEARS', 'OPENING_COST_AMORTIZATION_MONTHS')),
	CONSTRAINT "tax_parameters_value" CHECK("tax_parameters"."value" > 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `tax_parameters`("key", "effective_from", "effective_to", "value", "source_url") SELECT "key", "effective_from", "effective_to", "value", "source_url" FROM `__old_tax_parameters`;--> statement-breakpoint
DROP TABLE `__old_tax_parameters`;--> statement-breakpoint
CREATE TABLE `__old_closing_audit_log` AS SELECT * FROM `closing_audit_log`;--> statement-breakpoint
DROP TABLE `closing_audit_log`;--> statement-breakpoint
CREATE TABLE `closing_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "closing_audit_log_target_type" CHECK("closing_audit_log"."target_type" IN ('home_use_allocation', 'rent_detail', 'fixed_asset', 'blue_deduction_answer', 'closing_note', 'account_report_line', 'deferred_asset', 'deferred_amortization')),
	CONSTRAINT "closing_audit_log_action" CHECK("closing_audit_log"."action" IN ('create', 'update', 'dispose', 'delete'))
) STRICT;
--> statement-breakpoint
INSERT INTO `closing_audit_log`("id", "occurred_at", "target_type", "target_id", "action", "reason", "before_json", "after_json") SELECT "id", "occurred_at", "target_type", "target_id", "action", "reason", "before_json", "after_json" FROM `__old_closing_audit_log`;--> statement-breakpoint
DROP TABLE `__old_closing_audit_log`;--> statement-breakpoint
CREATE INDEX `closing_audit_log_target` ON `closing_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `__old_fixed_assets` AS SELECT * FROM `fixed_assets`;--> statement-breakpoint
DROP TABLE `fixed_assets`;--> statement-breakpoint
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
	`in_service_on` text,
	`prior_accumulated` integer DEFAULT 0 NOT NULL,
	`prior_through_year` integer,
	`disposal_kind` text,
	FOREIGN KEY (`asset_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fixed_assets_name" CHECK(length("fixed_assets"."name") > 0),
	CONSTRAINT "fixed_assets_cost" CHECK("fixed_assets"."acquisition_cost" > 0),
	CONSTRAINT "fixed_assets_method" CHECK("fixed_assets"."method" IN ('small_asset_28_2', 'straight_line', 'lump_sum')),
	CONSTRAINT "fixed_assets_ratio" CHECK("fixed_assets"."business_ratio" BETWEEN 0 AND 10000),
	CONSTRAINT "fixed_assets_prior" CHECK("fixed_assets"."prior_accumulated" >= 0),
	CONSTRAINT "fixed_assets_prior_year" CHECK("fixed_assets"."prior_accumulated" = 0 OR "fixed_assets"."prior_through_year" IS NOT NULL),
	CONSTRAINT "fixed_assets_useful_life" CHECK("fixed_assets"."method" <> 'straight_line' OR "fixed_assets"."useful_life_years" IS NOT NULL),
	CONSTRAINT "fixed_assets_disposal_kind" CHECK("fixed_assets"."disposal_kind" IN ('scrap', 'sale')),
	CONSTRAINT "fixed_assets_disposal_pair" CHECK(("fixed_assets"."disposed_on" IS NULL) = ("fixed_assets"."disposal_kind" IS NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO `fixed_assets`("id", "name", "quantity", "acquired_on", "acquisition_cost", "method", "useful_life_years", "business_ratio", "asset_account_id", "linked_journal_id", "note", "disposed_on", "created_at", "updated_at", "in_service_on", "prior_accumulated", "prior_through_year", "disposal_kind") SELECT "id", "name", "quantity", "acquired_on", "acquisition_cost", "method", "useful_life_years", "business_ratio", "asset_account_id", "linked_journal_id", "note", "disposed_on", "created_at", "updated_at", NULL, 0, NULL, CASE WHEN "disposed_on" IS NULL THEN NULL ELSE 'scrap' END FROM `__old_fixed_assets`;--> statement-breakpoint
DROP TABLE `__old_fixed_assets`;--> statement-breakpoint
CREATE TABLE `__old_adjustment_journal_refs` AS SELECT * FROM `adjustment_journal_refs`;--> statement-breakpoint
DROP TABLE `adjustment_journal_refs`;--> statement-breakpoint
CREATE TABLE `adjustment_journal_refs` (
	`journal_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`allocation_id` text,
	`asset_id` text,
	`fiscal_year` integer NOT NULL,
	`deferred_asset_id` text,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`allocation_id`) REFERENCES `home_use_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `fixed_assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deferred_asset_id`) REFERENCES `deferred_assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "adjustment_journal_refs_kind" CHECK("adjustment_journal_refs"."kind" IN ('home_use', 'depreciation', 'deferred_amortization')),
	CONSTRAINT "adjustment_journal_refs_source" CHECK(("adjustment_journal_refs"."kind" <> 'home_use' OR "adjustment_journal_refs"."allocation_id" IS NOT NULL) AND ("adjustment_journal_refs"."kind" <> 'depreciation' OR "adjustment_journal_refs"."asset_id" IS NOT NULL) AND ("adjustment_journal_refs"."kind" <> 'deferred_amortization' OR "adjustment_journal_refs"."deferred_asset_id" IS NOT NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO `adjustment_journal_refs`("journal_id", "kind", "allocation_id", "asset_id", "fiscal_year", "deferred_asset_id") SELECT "journal_id", "kind", "allocation_id", "asset_id", "fiscal_year", NULL FROM `__old_adjustment_journal_refs`;--> statement-breakpoint
DROP TABLE `__old_adjustment_journal_refs`;--> statement-breakpoint
CREATE INDEX `adjustment_journal_refs_year` ON `adjustment_journal_refs` (`fiscal_year`);
