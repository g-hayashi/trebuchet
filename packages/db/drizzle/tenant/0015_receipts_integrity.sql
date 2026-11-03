-- 手書きのマイグレーション: 010-receipts のトリガーと税制の値（data-model §1.1〜1.6、research R7・R20）
-- 5 表はどれも物理削除しない（論理削除は receipts.deleted_at）
CREATE TRIGGER `receipts_no_delete` BEFORE DELETE ON `receipts`
BEGIN
	SELECT RAISE(ABORT, 'receipts cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_files_no_delete` BEFORE DELETE ON `receipt_files`
BEGIN
	SELECT RAISE(ABORT, 'receipt_files cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_links_no_delete` BEFORE DELETE ON `receipt_links`
BEGIN
	SELECT RAISE(ABORT, 'receipt_links cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_no_delete` BEFORE DELETE ON `receipt_readings`
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_audit_log_no_delete` BEFORE DELETE ON `receipt_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'receipt_audit_log cannot be deleted');
END;
--> statement-breakpoint
-- 不変の表: ファイルの版（差し替えは新しい版の行を足す）と履歴（追記のみ）
CREATE TRIGGER `receipt_files_no_update` BEFORE UPDATE ON `receipt_files`
BEGIN
	SELECT RAISE(ABORT, 'receipt_files is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_audit_log_no_update` BEFORE UPDATE ON `receipt_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'receipt_audit_log is append-only');
END;
--> statement-breakpoint
-- receipts: 受領日時・経路・ID は変えない。deleted_at は NULL から値へ 1 回だけ（削除の取り消しはない。R7）
CREATE TRIGGER `receipts_immutable` BEFORE UPDATE ON `receipts`
WHEN NEW.`received_at` IS NOT OLD.`received_at` OR NEW.`channel` IS NOT OLD.`channel` OR NEW.`id` IS NOT OLD.`id`
BEGIN
	SELECT RAISE(ABORT, 'receipts.received_at, channel and id are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `receipts_deleted_once` BEFORE UPDATE OF `deleted_at`, `deleted_reason` ON `receipts`
WHEN OLD.`deleted_at` IS NOT NULL AND (NEW.`deleted_at` IS NOT OLD.`deleted_at` OR NEW.`deleted_reason` IS NOT OLD.`deleted_reason`)
BEGIN
	SELECT RAISE(ABORT, 'receipts.deleted_at can be set only once');
END;
--> statement-breakpoint
-- receipt_links: 結びつきの中身は変えない。閉じる（unlinked_at・unlink_reason を NULL から値へ）のは 1 回だけ
CREATE TRIGGER `receipt_links_immutable` BEFORE UPDATE ON `receipt_links`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`receipt_id` IS NOT OLD.`receipt_id` OR NEW.`journal_id` IS NOT OLD.`journal_id` OR NEW.`linked_at` IS NOT OLD.`linked_at`
BEGIN
	SELECT RAISE(ABORT, 'receipt_links.id, receipt_id, journal_id and linked_at are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_links_unlink_once` BEFORE UPDATE OF `unlinked_at`, `unlink_reason` ON `receipt_links`
WHEN OLD.`unlinked_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_links can be unlinked only once');
END;
--> statement-breakpoint
-- receipt_readings: 記録した値（読み取りの結果）は変えない。値の比べは列ごとに NULL から値へ 1 回だけ
-- （値の保存の比べと仕訳の登録の比べは別の機会なので、片方が書いても残りの列は後から書ける。L2）
CREATE TRIGGER `receipt_readings_immutable` BEFORE UPDATE ON `receipt_readings`
WHEN NEW.`id` IS NOT OLD.`id` OR NEW.`receipt_id` IS NOT OLD.`receipt_id` OR NEW.`file_sha256` IS NOT OLD.`file_sha256` OR NEW.`read_at` IS NOT OLD.`read_at` OR NEW.`model` IS NOT OLD.`model` OR NEW.`status` IS NOT OLD.`status` OR NEW.`error_code` IS NOT OLD.`error_code` OR NEW.`cand_date` IS NOT OLD.`cand_date` OR NEW.`cand_amount` IS NOT OLD.`cand_amount` OR NEW.`cand_partner` IS NOT OLD.`cand_partner` OR NEW.`cand_account_code` IS NOT OLD.`cand_account_code` OR NEW.`cand_tax_category` IS NOT OLD.`cand_tax_category` OR NEW.`confidence` IS NOT OLD.`confidence`
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings recorded values are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_compared_at_once` BEFORE UPDATE OF `compared_at` ON `receipt_readings`
WHEN OLD.`compared_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.compared_at can be set only once');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_date_match_once` BEFORE UPDATE OF `date_match` ON `receipt_readings`
WHEN OLD.`date_match` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.date_match can be set only once');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_amount_match_once` BEFORE UPDATE OF `amount_match` ON `receipt_readings`
WHEN OLD.`amount_match` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.amount_match can be set only once');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_partner_match_once` BEFORE UPDATE OF `partner_match` ON `receipt_readings`
WHEN OLD.`partner_match` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.partner_match can be set only once');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_account_match_once` BEFORE UPDATE OF `account_match` ON `receipt_readings`
WHEN OLD.`account_match` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.account_match can be set only once');
END;
--> statement-breakpoint
CREATE TRIGGER `receipt_readings_tax_match_once` BEFORE UPDATE OF `tax_match` ON `receipt_readings`
WHEN OLD.`tax_match` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'receipt_readings.tax_match can be set only once');
END;
--> statement-breakpoint
-- 税制の値（data-model §1.6、research R2・R3）。正本は domain の seed/tax-parameters.ts。既存の行は書き換えない
-- 出典: スキャナ一問一答 令和8年7月（問22・23・26）
INSERT INTO `tax_parameters` (`key`, `effective_from`, `effective_to`, `value`, `source_url`) VALUES
	('RECEIPT_INPUT_CYCLE_MONTHS', '2024-01-01', NULL, 2, 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf'),
	('RECEIPT_INPUT_GRACE_BUSINESS_DAYS', '2024-01-01', NULL, 7, 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf'),
	('RECEIPT_SCAN_MIN_LONG_PX', '2024-01-01', NULL, 2338, 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf'),
	('RECEIPT_SCAN_MIN_SHORT_PX', '2024-01-01', NULL, 1654, 'https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf');
