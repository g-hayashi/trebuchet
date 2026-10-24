CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "app_settings_key" CHECK("app_settings"."key" IN ('mac_id', 'remote_enabled', 'remote_host', 'backup_folder', 'backup_passphrase_set', 'backup_force_write', 'recovery_code_acknowledged'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`kind` text NOT NULL,
	`rp_id` text,
	`passkey_id` text,
	`session_id` text,
	`user_agent` text,
	`detail` text,
	CONSTRAINT "auth_events_kind" CHECK("auth_events"."kind" IN ('register', 'sign_in', 'sign_in_failed', 'recovery_used', 'recovery_failed', 'recovery_regenerated', 'passkey_renamed', 'passkey_deleted', 'session_revoked', 'sign_out', 'pairing_issued', 'pairing_used', 'remote_settings_changed'))
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
CREATE TABLE `pairing_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`rp_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_tokens_token_hash_unique` ON `pairing_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`rp_id` text NOT NULL,
	`transports` text,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT "passkeys_counter" CHECK("passkeys"."counter" >= 0),
	CONSTRAINT "passkeys_name" CHECK(length("passkeys"."name") > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`rp_id` text NOT NULL,
	`passkey_id` text,
	`user_agent` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT "sessions_kind" CHECK("sessions"."kind" IN ('normal', 'recovery'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
