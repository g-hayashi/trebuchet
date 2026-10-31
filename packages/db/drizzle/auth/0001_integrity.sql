-- 手書きのマイグレーション: トリガーと部分 UNIQUE インデックス（004 の data-model §1.4、008 の D2・INV-53）
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
-- recovery の包みは常に 1 行（passkey の包みは credential_id の UNIQUE で資格情報ごとに 1 行）
CREATE UNIQUE INDEX `key_wraps_one_recovery` ON `key_wraps` ((1)) WHERE `kind` = 'recovery';
