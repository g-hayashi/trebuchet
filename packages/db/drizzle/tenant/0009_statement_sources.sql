-- 007-generic-statement-import（data-model §1・§2）。drizzle-kit generate の出力を手で直した:
-- ・新しい表を STRICT にした（001/R2）
-- ・statement_batches の写しは、旧い表に source_name がないので NULL を入れる（生成の SELECT は旧い表の source_name を読んで失敗する）
-- ・マイグレーションはトランザクションの中で走り、PRAGMA foreign_keys は効かない。statements.batch_id が参照する
--   statement_batches を DROP するので、PRAGMA defer_foreign_keys で検査をコミットまで遅らせ、
--   最終の名前の表を作って写す（RENAME は使わない。写しの INSERT が違反の数を戻す）
CREATE TABLE `statement_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fixed_account_name` text,
	`header_signature` text,
	`mapping_json` text NOT NULL,
	`last_used_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "statement_sources_name" CHECK(length("statement_sources"."name") BETWEEN 1 AND 100)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_sources_name_unique` ON `statement_sources` (`name`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_statement_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	CONSTRAINT "statement_audit_log_target_type" CHECK("__new_statement_audit_log"."target_type" IN ('statement_batch', 'statement', 'statement_link', 'statement_account', 'inference_rule', 'statement_settings', 'statement_source')),
	CONSTRAINT "statement_audit_log_action" CHECK("__new_statement_audit_log"."action" IN ('create', 'update', 'exclude', 'unexclude', 'acknowledge', 'unlink', 'revoke', 'pause', 'resume', 'edit', 'seed', 'delete'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_statement_audit_log`("id", "occurred_at", "target_type", "target_id", "action", "reason", "before_json", "after_json") SELECT "id", "occurred_at", "target_type", "target_id", "action", "reason", "before_json", "after_json" FROM `statement_audit_log`;--> statement-breakpoint
DROP TABLE `statement_audit_log`;--> statement-breakpoint
ALTER TABLE `__new_statement_audit_log` RENAME TO `statement_audit_log`;--> statement-breakpoint
CREATE INDEX `statement_audit_log_target` ON `statement_audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `__old_statement_batches` AS SELECT * FROM `statement_batches`;--> statement-breakpoint
DROP TABLE `statement_batches`;--> statement-breakpoint
CREATE TABLE `statement_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`source_name` text,
	`input_sha256` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`count_new` integer NOT NULL,
	`count_existing` integer NOT NULL,
	`count_unreadable` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "statement_batches_origin" CHECK("statement_batches"."origin" IN ('paste', 'file')),
	CONSTRAINT "statement_batches_count_new" CHECK("statement_batches"."count_new" >= 0),
	CONSTRAINT "statement_batches_count_existing" CHECK("statement_batches"."count_existing" >= 0),
	CONSTRAINT "statement_batches_count_unreadable" CHECK("statement_batches"."count_unreadable" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `statement_batches`("id", "origin", "source_name", "input_sha256", "period_from", "period_to", "count_new", "count_existing", "count_unreadable", "created_at") SELECT "id", "origin", NULL, "input_sha256", "period_from", "period_to", "count_new", "count_existing", "count_unreadable", "created_at" FROM `__old_statement_batches`;--> statement-breakpoint
DROP TABLE `__old_statement_batches`;
