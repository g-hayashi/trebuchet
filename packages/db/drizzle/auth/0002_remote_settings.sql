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
CREATE TABLE `remote_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`host` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "remote_settings_single" CHECK("remote_settings"."id" = 1),
	CONSTRAINT "remote_settings_enabled" CHECK("remote_settings"."enabled" IN (0, 1)),
	CONSTRAINT "remote_settings_host" CHECK("remote_settings"."host" IS NULL OR "remote_settings"."host" LIKE '%.ts.net'),
	CONSTRAINT "remote_settings_enabled_host" CHECK("remote_settings"."enabled" = 0 OR "remote_settings"."host" IS NOT NULL)
) STRICT;
