CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`local_enabled` integer DEFAULT 1 NOT NULL,
	`external_enabled` integer DEFAULT 0 NOT NULL,
	`external_base_url` text,
	`external_model` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "ai_settings_single" CHECK("ai_settings"."id" = 1),
	CONSTRAINT "ai_settings_local_enabled" CHECK("ai_settings"."local_enabled" IN (0, 1)),
	CONSTRAINT "ai_settings_external_enabled" CHECK("ai_settings"."external_enabled" IN (0, 1)),
	CONSTRAINT "ai_settings_external" CHECK("ai_settings"."external_enabled" = 0 OR ("ai_settings"."external_base_url" IS NOT NULL AND "ai_settings"."external_model" IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "app_settings_key" CHECK("app_settings"."key" IN ('mac_id', 'remote_enabled', 'remote_host', 'backup_folder', 'backup_force_write', 'recovery_code_acknowledged'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`file_name` text,
	`size_bytes` integer,
	`content_sha256` text,
	`summary` text,
	CONSTRAINT "backup_runs_trigger" CHECK("backup_runs"."trigger" IN ('manual', 'auto')),
	CONSTRAINT "backup_runs_status" CHECK("backup_runs"."status" IN ('succeeded', 'skipped', 'failed'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`db_file` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "entities_kind" CHECK("entities"."kind" IN ('individual', 'corporation'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_db_file_unique` ON `entities` (`db_file`);--> statement-breakpoint
CREATE TABLE `pairing_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`rp_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_tokens_token_hash_unique` ON `pairing_tokens` (`token_hash`);