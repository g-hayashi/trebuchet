-- 手書きのマイグレーション: 006-mfme-ai-journal のトリガー・式の UNIQUE（data-model §3、research R16）
-- journals.source の列挙に statement を足す。SQLite はトリガーの ALTER がないので DROP して作り直す
DROP TRIGGER `journals_source_insert`;
--> statement-breakpoint
DROP TRIGGER `journals_source_update`;
--> statement-breakpoint
CREATE TRIGGER `journals_source_insert` BEFORE INSERT ON `journals`
WHEN NEW.`source` NOT IN ('manual', 'import_freee', 'invoice', 'payment', 'recurring', 'statement')
BEGIN
	SELECT RAISE(ABORT, 'journals.source is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER `journals_source_update` BEFORE UPDATE OF `source` ON `journals`
WHEN NEW.`source` NOT IN ('manual', 'import_freee', 'invoice', 'payment', 'recurring', 'statement')
BEGIN
	SELECT RAISE(ABORT, 'journals.source is not allowed');
END;
--> statement-breakpoint
-- 式の UNIQUE（drizzle-kit が出力できない）: ルールは（正規化した内容, 口座 | すべての口座）で一意
CREATE UNIQUE INDEX `inference_rules_key` ON `inference_rules` (`normalized_content`, ifnull(`statement_account_id`, ''));
--> statement-breakpoint
CREATE TRIGGER `statements_no_delete` BEFORE DELETE ON `statements`
BEGIN
	SELECT RAISE(ABORT, 'statements cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_links_no_delete` BEFORE DELETE ON `statement_links`
BEGIN
	SELECT RAISE(ABORT, 'statement_links cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_batches_no_delete` BEFORE DELETE ON `statement_batches`
BEGIN
	SELECT RAISE(ABORT, 'statement_batches cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_batches_no_update` BEFORE UPDATE ON `statement_batches`
BEGIN
	SELECT RAISE(ABORT, 'statement_batches is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `inference_rule_history_no_update` BEFORE UPDATE ON `inference_rule_history`
BEGIN
	SELECT RAISE(ABORT, 'inference_rule_history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `inference_rule_history_no_delete` BEFORE DELETE ON `inference_rule_history`
BEGIN
	SELECT RAISE(ABORT, 'inference_rule_history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_audit_log_no_update` BEFORE UPDATE ON `statement_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'statement_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_audit_log_no_delete` BEFORE DELETE ON `statement_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'statement_audit_log is append-only');
END;
--> statement-breakpoint
-- 明細の内容は取込のあと変えない。更新できるのは changed_json・changed_ack_at・excluded_at・excluded_reason だけ
CREATE TRIGGER `statements_restricted_update` BEFORE UPDATE ON `statements`
WHEN NEW.`id` IS NOT OLD.`id`
	OR NEW.`batch_id` IS NOT OLD.`batch_id`
	OR NEW.`statement_account_id` IS NOT OLD.`statement_account_id`
	OR NEW.`stable_key` IS NOT OLD.`stable_key`
	OR NEW.`external_id` IS NOT OLD.`external_id`
	OR NEW.`date` IS NOT OLD.`date`
	OR NEW.`amount` IS NOT OLD.`amount`
	OR NEW.`content` IS NOT OLD.`content`
	OR NEW.`normalized_content` IS NOT OLD.`normalized_content`
	OR NEW.`category_major` IS NOT OLD.`category_major`
	OR NEW.`category_minor` IS NOT OLD.`category_minor`
	OR NEW.`memo` IS NOT OLD.`memo`
	OR NEW.`transfer_flag` IS NOT OLD.`transfer_flag`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'statements: only changed_json, changed_ack_at, excluded_at and excluded_reason can be updated');
END;
--> statement-breakpoint
-- 結びつきは追記のみ。更新できるのは revoked_at・revoked_reason だけ
CREATE TRIGGER `statement_links_revoke_only` BEFORE UPDATE ON `statement_links`
WHEN NEW.`id` IS NOT OLD.`id`
	OR NEW.`statement_id` IS NOT OLD.`statement_id`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`journal_line_id` IS NOT OLD.`journal_line_id`
	OR NEW.`kind` IS NOT OLD.`kind`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'statement_links: only revoked_at and revoked_reason can be updated');
END;
--> statement-breakpoint
-- journal_line_id の行は journal_id の仕訳のものでなければならない
CREATE TRIGGER `statement_links_line_in_journal` BEFORE INSERT ON `statement_links`
WHEN NOT EXISTS (
	SELECT 1 FROM `journal_lines` WHERE `id` = NEW.`journal_line_id` AND `journal_id` = NEW.`journal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'statement_links.journal_line_id does not belong to journal_id');
END;
