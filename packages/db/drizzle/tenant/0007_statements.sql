CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`split_date` text NOT NULL,
	`include_ai` integer NOT NULL,
	`sample_count` integer NOT NULL,
	`result_json` text NOT NULL,
	`models_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "eval_runs_include_ai" CHECK("eval_runs"."include_ai" IN (0, 1)),
	CONSTRAINT "eval_runs_sample_count" CHECK("eval_runs"."sample_count" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `inference_rule_history` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`statement_id` text,
	`at` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `inference_rules`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_rule_history_action" CHECK("inference_rule_history"."action" IN ('create', 'update', 'pause', 'resume', 'edit'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `inference_rule_history_rule` ON `inference_rule_history` (`rule_id`);--> statement-breakpoint
CREATE TABLE `inference_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_content` text NOT NULL,
	`statement_account_id` text,
	`counter_account_id` text NOT NULL,
	`counter_sub_account_id` text,
	`partner_id` text,
	`tax_category` text NOT NULL,
	`purpose` text NOT NULL,
	`description_template` text,
	`hits` integer DEFAULT 0 NOT NULL,
	`overrides` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`statement_account_id`) REFERENCES `statement_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`counter_sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_id`) REFERENCES `partners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_category`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_rules_purpose" CHECK("inference_rules"."purpose" IN ('business', 'private')),
	CONSTRAINT "inference_rules_status" CHECK("inference_rules"."status" IN ('active', 'paused')),
	CONSTRAINT "inference_rules_origin" CHECK("inference_rules"."origin" IN ('approval', 'seed')),
	CONSTRAINT "inference_rules_hits" CHECK("inference_rules"."hits" >= 0),
	CONSTRAINT "inference_rules_overrides" CHECK("inference_rules"."overrides" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `statement_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`usage` text NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`sub_account_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statement_accounts_usage" CHECK("statement_accounts"."usage" IN ('business', 'mixed', 'private')),
	CONSTRAINT "statement_accounts_kind" CHECK("statement_accounts"."kind" IN ('bank', 'card', 'cash', 'other')),
	CONSTRAINT "statement_accounts_account" CHECK(("statement_accounts"."usage" = 'private' AND "statement_accounts"."account_id" IS NULL AND "statement_accounts"."sub_account_id" IS NULL) OR ("statement_accounts"."usage" <> 'private' AND "statement_accounts"."account_id" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_accounts_name_unique` ON `statement_accounts` (`name`);--> statement-breakpoint
CREATE TABLE `statement_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "statement_audit_log_target_type" CHECK("statement_audit_log"."target_type" IN ('statement_batch', 'statement', 'statement_link', 'statement_account', 'inference_rule', 'statement_settings')),
	CONSTRAINT "statement_audit_log_action" CHECK("statement_audit_log"."action" IN ('create', 'update', 'exclude', 'unexclude', 'acknowledge', 'unlink', 'revoke', 'pause', 'resume', 'edit', 'seed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `statement_audit_log_target` ON `statement_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `statement_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`input_sha256` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`count_new` integer NOT NULL,
	`count_existing` integer NOT NULL,
	`count_unreadable` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "statement_batches_origin" CHECK("statement_batches"."origin" IN ('paste', 'mfme_fetch')),
	CONSTRAINT "statement_batches_count_new" CHECK("statement_batches"."count_new" >= 0),
	CONSTRAINT "statement_batches_count_existing" CHECK("statement_batches"."count_existing" >= 0),
	CONSTRAINT "statement_batches_count_unreadable" CHECK("statement_batches"."count_unreadable" >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `statement_candidates` (
	`statement_id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`purpose` text,
	`confidence` integer,
	`reason` text NOT NULL,
	`draft_json` text,
	`rule_id` text,
	`model` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `inference_rules`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statement_candidates_method" CHECK("statement_candidates"."method" IN ('match', 'transfer', 'rule', 'local_ai', 'external_ai', 'none')),
	CONSTRAINT "statement_candidates_purpose" CHECK("statement_candidates"."purpose" IN ('business', 'private')),
	CONSTRAINT "statement_candidates_confidence" CHECK("statement_candidates"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "statement_candidates_shape" CHECK(("statement_candidates"."method" = 'none' AND "statement_candidates"."purpose" IS NULL AND "statement_candidates"."confidence" IS NULL AND "statement_candidates"."draft_json" IS NULL) OR ("statement_candidates"."method" <> 'none' AND "statement_candidates"."purpose" IS NOT NULL AND "statement_candidates"."confidence" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE `statement_links` (
	`id` text PRIMARY KEY NOT NULL,
	`statement_id` text NOT NULL,
	`journal_id` text NOT NULL,
	`journal_line_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`revoked_reason` text,
	FOREIGN KEY (`statement_id`) REFERENCES `statements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`journal_line_id`) REFERENCES `journal_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statement_links_kind" CHECK("statement_links"."kind" IN ('created', 'matched'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_links_active_statement` ON `statement_links` (`statement_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `statement_links_active_line` ON `statement_links` (`journal_line_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `statement_links_journal` ON `statement_links` (`journal_id`);--> statement-breakpoint
CREATE TABLE `statement_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`bulk_threshold` integer DEFAULT 80 NOT NULL,
	`external_threshold` integer DEFAULT 60 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "statement_settings_single" CHECK("statement_settings"."id" = 1),
	CONSTRAINT "statement_settings_bulk" CHECK("statement_settings"."bulk_threshold" BETWEEN 0 AND 100),
	CONSTRAINT "statement_settings_external" CHECK("statement_settings"."external_threshold" BETWEEN 0 AND 100)
) STRICT;
--> statement-breakpoint
CREATE TABLE `statements` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`statement_account_id` text NOT NULL,
	`stable_key` text NOT NULL,
	`external_id` text,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`content` text NOT NULL,
	`normalized_content` text NOT NULL,
	`category_major` text,
	`category_minor` text,
	`memo` text,
	`transfer_flag` integer NOT NULL,
	`changed_json` text,
	`changed_ack_at` text,
	`excluded_at` text,
	`excluded_reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `statement_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_account_id`) REFERENCES `statement_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statements_amount" CHECK(abs("statements"."amount") < 1000000000000),
	CONSTRAINT "statements_transfer_flag" CHECK("statements"."transfer_flag" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `statements_stable_key_unique` ON `statements` (`stable_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `statements_external_id` ON `statements` (`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `statements_account_date` ON `statements` (`statement_account_id`,`date`);--> statement-breakpoint
CREATE INDEX `statements_batch` ON `statements` (`batch_id`);