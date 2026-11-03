-- 010-receipts（data-model §1.1〜1.6、§5、research R20）。drizzle-kit generate の出力を手で直した:
-- ・新しい 5 表を STRICT にした（001/R2）
-- ・循環した 2 つの外部キー（receipts.current_sha256 → receipt_files、receipt_files.receipt_id → receipts）に
--   DEFERRABLE INITIALLY DEFERRED を書き足した（drizzle-kit は出力しない。I1・§1.1）。コミットの時点で検査される
-- ・tax_parameters は key の CHECK の変更なので作り直す（009 の 0011 と同じ手順: 最終の名前の表を作って写す。
--   RENAME は使わない。CHECK の中の表名が __new_ のまま残るため）。既存の行は全部写す
-- ・tax_parameters に付いたトリガーはない（4 つの新しい key の行は 0015 で入れる）
CREATE TABLE `receipt_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`receipt_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_audit_log_target_type" CHECK("receipt_audit_log"."target_type" IN ('receipt', 'receipt_link', 'receipt_reading')),
	CONSTRAINT "receipt_audit_log_action" CHECK("receipt_audit_log"."action" IN ('create', 'update', 'replace_file', 'delete', 'link', 'unlink', 'read'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `receipt_audit_log_target` ON `receipt_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `receipt_audit_log_receipt` ON `receipt_audit_log` (`receipt_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `receipt_files` (
	`sha256` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`file_version` integer NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`original_name` text NOT NULL,
	`width` integer,
	`height` integer,
	`full_color` integer,
	`added_at` text NOT NULL,
	`channel` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "receipt_files_sha256" CHECK(length("receipt_files"."sha256") = 64 AND "receipt_files"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "receipt_files_version_min" CHECK("receipt_files"."file_version" >= 1),
	CONSTRAINT "receipt_files_media_type" CHECK("receipt_files"."media_type" IN ('image/jpeg', 'image/png', 'image/heic', 'application/pdf')),
	CONSTRAINT "receipt_files_size" CHECK("receipt_files"."size_bytes" > 0 AND "receipt_files"."size_bytes" <= 20971520),
	CONSTRAINT "receipt_files_width" CHECK("receipt_files"."width" IS NULL OR "receipt_files"."width" > 0),
	CONSTRAINT "receipt_files_height" CHECK("receipt_files"."height" IS NULL OR "receipt_files"."height" > 0),
	CONSTRAINT "receipt_files_full_color" CHECK("receipt_files"."full_color" IS NULL OR "receipt_files"."full_color" IN (0, 1)),
	CONSTRAINT "receipt_files_channel" CHECK("receipt_files"."channel" IN ('local', 'remote'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_files_version` ON `receipt_files` (`receipt_id`,`file_version`);--> statement-breakpoint
CREATE TABLE `receipt_links` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`linked_at` text NOT NULL,
	`unlinked_at` text,
	`unlink_reason` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_links_unlinked" CHECK(("receipt_links"."unlinked_at" IS NULL) = ("receipt_links"."unlink_reason" IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_links_active` ON `receipt_links` (`receipt_id`) WHERE unlinked_at IS NULL;--> statement-breakpoint
CREATE INDEX `receipt_links_journal` ON `receipt_links` (`journal_id`) WHERE unlinked_at IS NULL;--> statement-breakpoint
CREATE TABLE `receipt_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`file_sha256` text NOT NULL,
	`read_at` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`cand_date` text,
	`cand_amount` integer,
	`cand_partner` text,
	`cand_account_code` text,
	`cand_tax_category` text,
	`confidence` integer,
	`compared_at` text,
	`date_match` integer,
	`amount_match` integer,
	`partner_match` integer,
	`account_match` integer,
	`tax_match` integer,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_sha256`) REFERENCES `receipt_files`(`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_readings_status" CHECK("receipt_readings"."status" IN ('succeeded', 'invalid', 'failed', 'timeout')),
	CONSTRAINT "receipt_readings_error_code" CHECK("receipt_readings"."status" <> 'succeeded' OR "receipt_readings"."error_code" IS NULL),
	CONSTRAINT "receipt_readings_candidates" CHECK("receipt_readings"."status" = 'succeeded' OR ("receipt_readings"."cand_date" IS NULL AND "receipt_readings"."cand_amount" IS NULL AND "receipt_readings"."cand_partner" IS NULL AND "receipt_readings"."cand_account_code" IS NULL AND "receipt_readings"."cand_tax_category" IS NULL AND "receipt_readings"."confidence" IS NULL)),
	CONSTRAINT "receipt_readings_confidence" CHECK("receipt_readings"."confidence" IS NULL OR "receipt_readings"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "receipt_readings_matches" CHECK(("receipt_readings"."date_match" IS NULL OR "receipt_readings"."date_match" IN (0, 1)) AND ("receipt_readings"."amount_match" IS NULL OR "receipt_readings"."amount_match" IN (0, 1)) AND ("receipt_readings"."partner_match" IS NULL OR "receipt_readings"."partner_match" IN (0, 1)) AND ("receipt_readings"."account_match" IS NULL OR "receipt_readings"."account_match" IN (0, 1)) AND ("receipt_readings"."tax_match" IS NULL OR "receipt_readings"."tax_match" IN (0, 1)))
) STRICT;
--> statement-breakpoint
CREATE INDEX `receipt_readings_receipt` ON `receipt_readings` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`received_at` text NOT NULL,
	`channel` text NOT NULL,
	`category` text NOT NULL,
	`current_sha256` text NOT NULL,
	`transaction_date` text,
	`amount` integer,
	`partner_name` text,
	`partner_key` text,
	`memo` text,
	`deleted_at` text,
	`deleted_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`current_sha256`) REFERENCES `receipt_files`(`sha256`) ON UPDATE no action ON DELETE no action DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "receipts_channel" CHECK("receipts"."channel" IN ('local', 'remote')),
	CONSTRAINT "receipts_category" CHECK("receipts"."category" IN ('paper_scan', 'electronic')),
	CONSTRAINT "receipts_amount_range" CHECK("receipts"."amount" IS NULL OR ("receipts"."amount" > 0 AND "receipts"."amount" < 1000000000000)),
	CONSTRAINT "receipts_partner_name" CHECK("receipts"."partner_name" IS NULL OR (length(trim("receipts"."partner_name")) > 0 AND length("receipts"."partner_name") <= 100)),
	CONSTRAINT "receipts_partner_key" CHECK(("receipts"."partner_name" IS NULL) = ("receipts"."partner_key" IS NULL)),
	CONSTRAINT "receipts_memo" CHECK("receipts"."memo" IS NULL OR length("receipts"."memo") <= 500),
	CONSTRAINT "receipts_deleted" CHECK(("receipts"."deleted_at" IS NULL) = ("receipts"."deleted_reason" IS NULL)),
	CONSTRAINT "receipts_version" CHECK("receipts"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE INDEX `receipts_search_date` ON `receipts` (`deleted_at`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `receipts_amount` ON `receipts` (`amount`);--> statement-breakpoint
CREATE INDEX `receipts_received` ON `receipts` (`received_at`,`id`);--> statement-breakpoint
CREATE TABLE `__old_tax_parameters` AS SELECT * FROM `tax_parameters`;--> statement-breakpoint
DROP TABLE `tax_parameters`;--> statement-breakpoint
CREATE TABLE `tax_parameters` (
	`key` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`value` integer NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`key`, `effective_from`),
	CONSTRAINT "tax_parameters_key" CHECK("tax_parameters"."key" IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC', 'LUMP_SUM_COST_MIN', 'LUMP_SUM_COST_MAX', 'LUMP_SUM_YEARS', 'OPENING_COST_AMORTIZATION_MONTHS', 'RECEIPT_INPUT_CYCLE_MONTHS', 'RECEIPT_INPUT_GRACE_BUSINESS_DAYS', 'RECEIPT_SCAN_MIN_LONG_PX', 'RECEIPT_SCAN_MIN_SHORT_PX')),
	CONSTRAINT "tax_parameters_value" CHECK("tax_parameters"."value" > 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `tax_parameters`("key", "effective_from", "effective_to", "value", "source_url") SELECT "key", "effective_from", "effective_to", "value", "source_url" FROM `__old_tax_parameters`;--> statement-breakpoint
DROP TABLE `__old_tax_parameters`;
