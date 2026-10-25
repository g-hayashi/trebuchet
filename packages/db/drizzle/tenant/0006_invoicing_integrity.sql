-- 手書きのマイグレーション: 005-recurring-invoicing のトリガー（data-model §2、research R15）
-- journals.source に CHECK はない（作り直さない）。INSERT と UPDATE OF source のトリガーで列挙を検査する
CREATE TRIGGER `journals_source_insert` BEFORE INSERT ON `journals`
WHEN NEW.`source` NOT IN ('manual', 'import_freee', 'invoice', 'payment', 'recurring')
BEGIN
	SELECT RAISE(ABORT, 'journals.source is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER `journals_source_update` BEFORE UPDATE OF `source` ON `journals`
WHEN NEW.`source` NOT IN ('manual', 'import_freee', 'invoice', 'payment', 'recurring')
BEGIN
	SELECT RAISE(ABORT, 'journals.source is not allowed');
END;
--> statement-breakpoint
CREATE TRIGGER `invoices_no_delete` BEFORE DELETE ON `invoices`
BEGIN
	SELECT RAISE(ABORT, 'invoices cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_items_no_delete` BEFORE DELETE ON `invoice_items`
BEGIN
	SELECT RAISE(ABORT, 'invoice_items cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_payments_no_delete` BEFORE DELETE ON `invoice_payments`
BEGIN
	SELECT RAISE(ABORT, 'invoice_payments cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `recurring_runs_no_delete` BEFORE DELETE ON `recurring_runs`
BEGIN
	SELECT RAISE(ABORT, 'recurring_runs cannot be deleted');
END;
--> statement-breakpoint
-- INV-38: 請求書の写しは発行後に変えない。更新できるのは取消の列を NULL から一度だけ
CREATE TRIGGER `invoices_void_only` BEFORE UPDATE ON `invoices`
WHEN OLD.`voided_at` IS NOT NULL
	OR NEW.`id` IS NOT OLD.`id`
	OR NEW.`invoice_no` IS NOT OLD.`invoice_no`
	OR NEW.`seq` IS NOT OLD.`seq`
	OR NEW.`partner_id` IS NOT OLD.`partner_id`
	OR NEW.`target_month` IS NOT OLD.`target_month`
	OR NEW.`issue_date` IS NOT OLD.`issue_date`
	OR NEW.`sales_date` IS NOT OLD.`sales_date`
	OR NEW.`due_date` IS NOT OLD.`due_date`
	OR NEW.`recipient_name` IS NOT OLD.`recipient_name`
	OR NEW.`recipient_honorific` IS NOT OLD.`recipient_honorific`
	OR NEW.`issuer_json` IS NOT OLD.`issuer_json`
	OR NEW.`tax_display` IS NOT OLD.`tax_display`
	OR NEW.`total` IS NOT OLD.`total`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'invoices can only be voided once (immutable otherwise)');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_payments_void_only` BEFORE UPDATE ON `invoice_payments`
WHEN OLD.`voided_at` IS NOT NULL
	OR NEW.`id` IS NOT OLD.`id`
	OR NEW.`invoice_id` IS NOT OLD.`invoice_id`
	OR NEW.`received_on` IS NOT OLD.`received_on`
	OR NEW.`amount` IS NOT OLD.`amount`
	OR NEW.`fee_amount` IS NOT OLD.`fee_amount`
	OR NEW.`deposit_account_id` IS NOT OLD.`deposit_account_id`
	OR NEW.`deposit_sub_account_id` IS NOT OLD.`deposit_sub_account_id`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'invoice_payments can only be voided once (immutable otherwise)');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_items_no_update` BEFORE UPDATE ON `invoice_items`
BEGIN
	SELECT RAISE(ABORT, 'invoice_items cannot be updated');
END;
--> statement-breakpoint
-- R19・R21: 回の更新は acknowledged_at を NULL から付けるときだけ
CREATE TRIGGER `recurring_runs_ack_only` BEFORE UPDATE ON `recurring_runs`
WHEN OLD.`acknowledged_at` IS NOT NULL
	OR NEW.`acknowledged_at` IS NULL
	OR NEW.`id` IS NOT OLD.`id`
	OR NEW.`recurring_id` IS NOT OLD.`recurring_id`
	OR NEW.`target_month` IS NOT OLD.`target_month`
	OR NEW.`status` IS NOT OLD.`status`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`skip_reason` IS NOT OLD.`skip_reason`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'recurring_runs: only acknowledged_at can be set, once');
END;
--> statement-breakpoint
-- FR-004, INV-31: 次の通し番号は発行済みの最大の seq より大きい（発行済みがなければ検査しない）
CREATE TRIGGER `invoice_settings_seq_floor` BEFORE UPDATE ON `invoice_settings`
WHEN NEW.`next_seq` <= (SELECT max(`seq`) FROM `invoices`)
BEGIN
	SELECT RAISE(ABORT, 'invoice_settings.next_seq must be greater than the max issued seq');
END;
--> statement-breakpoint
CREATE TRIGGER `invoice_settings_seq_floor_insert` BEFORE INSERT ON `invoice_settings`
WHEN NEW.`next_seq` <= (SELECT max(`seq`) FROM `invoices`)
BEGIN
	SELECT RAISE(ABORT, 'invoice_settings.next_seq must be greater than the max issued seq');
END;
--> statement-breakpoint
CREATE TRIGGER `invoicing_audit_log_no_update` BEFORE UPDATE ON `invoicing_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'invoicing_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `invoicing_audit_log_no_delete` BEFORE DELETE ON `invoicing_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'invoicing_audit_log is append-only');
END;
