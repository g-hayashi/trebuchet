CREATE TABLE `import_account_mappings` (
	`source_name` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`sub_account_id` text,
	`sub_account_name` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sub_account_id`) REFERENCES `sub_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_account_mappings_sub_account" CHECK("import_account_mappings"."sub_account_id" IS NULL OR "import_account_mappings"."sub_account_name" IS NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`imported_at` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`fiscal_years_json` text NOT NULL,
	`count_new` integer NOT NULL,
	`count_already` integer NOT NULL,
	`count_excluded` integer NOT NULL,
	`count_rejected` integer NOT NULL,
	`count_warnings` integer NOT NULL,
	`status` text NOT NULL,
	`voided_at` text,
	`void_reason` text,
	CONSTRAINT "import_batches_source" CHECK("import_batches"."source" IN ('freee_journal')),
	CONSTRAINT "import_batches_sha256" CHECK(length("import_batches"."file_sha256") = 64 AND "import_batches"."file_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "import_batches_period" CHECK("import_batches"."period_from" <= "import_batches"."period_to"),
	CONSTRAINT "import_batches_count_new" CHECK("import_batches"."count_new" >= 1),
	CONSTRAINT "import_batches_counts" CHECK("import_batches"."count_already" >= 0 AND "import_batches"."count_excluded" >= 0 AND "import_batches"."count_rejected" >= 0 AND "import_batches"."count_warnings" >= 0),
	CONSTRAINT "import_batches_status" CHECK("import_batches"."status" IN ('active', 'voided')),
	CONSTRAINT "import_batches_void" CHECK("import_batches"."status" = 'active' OR ("import_batches"."voided_at" IS NOT NULL AND "import_batches"."void_reason" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE `import_journal_refs` (
	`journal_id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`freee_journal_id` text NOT NULL,
	`freee_journal_no` text,
	`freee_date` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`journal_id`) REFERENCES `journals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `import_journal_refs_active_freee_id` ON `import_journal_refs` (`freee_journal_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `import_journal_refs_batch` ON `import_journal_refs` (`batch_id`);--> statement-breakpoint
CREATE INDEX `import_journal_refs_freee_date` ON `import_journal_refs` (`freee_date`);--> statement-breakpoint
CREATE TABLE `import_tax_mappings` (
	`source_name` text PRIMARY KEY NOT NULL,
	`tax_category` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tax_category`) REFERENCES `tax_categories`(`code`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
-- 手書き: 取込の記録の削除を禁止し、参照の更新を revoked_at の設定だけに限る（data-model §2）
CREATE TRIGGER `import_batches_no_delete` BEFORE DELETE ON `import_batches`
BEGIN
	SELECT RAISE(ABORT, 'import_batches cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `import_journal_refs_no_delete` BEFORE DELETE ON `import_journal_refs`
BEGIN
	SELECT RAISE(ABORT, 'import_journal_refs cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `import_journal_refs_revoke_only` BEFORE UPDATE ON `import_journal_refs`
WHEN NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`batch_id` IS NOT OLD.`batch_id`
	OR NEW.`freee_journal_id` IS NOT OLD.`freee_journal_id`
	OR NEW.`freee_journal_no` IS NOT OLD.`freee_journal_no`
	OR NEW.`freee_date` IS NOT OLD.`freee_date`
	OR NEW.`snapshot_json` IS NOT OLD.`snapshot_json`
	OR OLD.`revoked_at` IS NOT NULL
	OR NEW.`revoked_at` IS NULL
BEGIN
	SELECT RAISE(ABORT, 'import_journal_refs: only revoked_at can be set');
END;
