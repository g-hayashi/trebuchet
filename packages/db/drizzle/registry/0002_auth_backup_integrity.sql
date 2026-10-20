-- 手書きのマイグレーション: トリガーと部分 UNIQUE インデックス（data-model §1.2, §1.4）
CREATE TRIGGER `auth_events_no_update` BEFORE UPDATE ON `auth_events`
BEGIN
	SELECT RAISE(ABORT, 'auth_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_events_no_delete` BEFORE DELETE ON `auth_events`
BEGIN
	SELECT RAISE(ABORT, 'auth_events is append-only');
END;
--> statement-breakpoint
-- 有効（used_at も revoked_at も NULL）な回復コードは高々1つ
CREATE UNIQUE INDEX `recovery_codes_one_active` ON `recovery_codes` ((1)) WHERE `used_at` IS NULL AND `revoked_at` IS NULL;
