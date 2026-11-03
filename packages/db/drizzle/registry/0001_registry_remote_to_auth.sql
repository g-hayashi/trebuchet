-- 004/T016: ペアリングのトークンとリモートの設定は auth.sqlite（暗号化しない）へ移した。
-- app_settings の remote_* の行は新しい CHECK に合わないので先に消す（開発中なので移行しない）
DROP TABLE `pairing_tokens`;--> statement-breakpoint
DELETE FROM `app_settings` WHERE `key` IN ('remote_enabled', 'remote_host');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "app_settings_key" CHECK("__new_app_settings"."key" IN ('mac_id', 'backup_folder', 'backup_force_write', 'recovery_code_acknowledged'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_app_settings`("key", "value", "updated_at") SELECT "key", "value", "updated_at" FROM `app_settings`;--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
