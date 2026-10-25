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
