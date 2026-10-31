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
CREATE TABLE `key_wraps` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`credential_id` text,
	`salt` blob NOT NULL,
	`iv` blob NOT NULL,
	`tag` blob NOT NULL,
	`wrapped` blob NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `passkeys`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "key_wraps_kind" CHECK("key_wraps"."kind" IN ('passkey', 'recovery')),
	CONSTRAINT "key_wraps_credential" CHECK(("key_wraps"."kind" = 'passkey') = ("key_wraps"."credential_id" IS NOT NULL)),
	CONSTRAINT "key_wraps_lengths" CHECK(length("key_wraps"."salt") = 32 AND length("key_wraps"."iv") = 12 AND length("key_wraps"."tag") = 16 AND length("key_wraps"."wrapped") = 32)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `key_wraps_credential_id_unique` ON `key_wraps` (`credential_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`rp_id` text NOT NULL,
	`transports` text,
	`name` text NOT NULL,
	`prf_salt` blob NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	CONSTRAINT "passkeys_counter" CHECK("passkeys"."counter" >= 0),
	CONSTRAINT "passkeys_name" CHECK(length("passkeys"."name") > 0),
	CONSTRAINT "passkeys_prf_salt" CHECK(length("passkeys"."prf_salt") = 32)
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