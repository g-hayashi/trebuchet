-- 010-receipts（data-model §1.7、research R15）。drizzle-kit generate の出力を手で直した:
-- ・ai_settings に receipt_images_enabled（既定 0。1 にできるのは external_enabled = 1 のときだけ）を足す。
--   CHECK の追加は表の作り直しになる。最終の名前の表を作って写す（RENAME は使わない。0001 と違い、
--   CHECK の中の表名が __new_ のまま残らないようにする）。STRICT を保つ（001/R2）
-- ・既存の行は receipt_images_enabled = 0 で写す（生成された INSERT は古い表にない列を読むので直した）
CREATE TABLE `__old_ai_settings` AS SELECT * FROM `ai_settings`;--> statement-breakpoint
DROP TABLE `ai_settings`;--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`local_enabled` integer DEFAULT 1 NOT NULL,
	`external_enabled` integer DEFAULT 0 NOT NULL,
	`external_base_url` text,
	`external_model` text,
	`receipt_images_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "ai_settings_single" CHECK("ai_settings"."id" = 1),
	CONSTRAINT "ai_settings_local_enabled" CHECK("ai_settings"."local_enabled" IN (0, 1)),
	CONSTRAINT "ai_settings_external_enabled" CHECK("ai_settings"."external_enabled" IN (0, 1)),
	CONSTRAINT "ai_settings_receipt_images_enabled" CHECK("ai_settings"."receipt_images_enabled" IN (0, 1)),
	CONSTRAINT "ai_settings_receipt_images_external" CHECK("ai_settings"."receipt_images_enabled" = 0 OR "ai_settings"."external_enabled" = 1),
	CONSTRAINT "ai_settings_external" CHECK("ai_settings"."external_enabled" = 0 OR ("ai_settings"."external_base_url" IS NOT NULL AND "ai_settings"."external_model" IS NOT NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO `ai_settings`("id", "local_enabled", "external_enabled", "external_base_url", "external_model", "receipt_images_enabled", "updated_at") SELECT "id", "local_enabled", "external_enabled", "external_base_url", "external_model", 0, "updated_at" FROM `__old_ai_settings`;--> statement-breakpoint
DROP TABLE `__old_ai_settings`;
