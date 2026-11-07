-- 013 源泉徴収（data-model §1.4、INV-38 と同じ考え方）。消し込みの写しは作成後に変えない。
-- 0006 の invoice_payments_void_only に withholding_amount を足して作り直す。更新できるのは取消の列を NULL から一度だけ
DROP TRIGGER `invoice_payments_void_only`;--> statement-breakpoint
CREATE TRIGGER `invoice_payments_void_only` BEFORE UPDATE ON `invoice_payments`
WHEN OLD.`voided_at` IS NOT NULL
	OR NEW.`id` IS NOT OLD.`id`
	OR NEW.`invoice_id` IS NOT OLD.`invoice_id`
	OR NEW.`received_on` IS NOT OLD.`received_on`
	OR NEW.`amount` IS NOT OLD.`amount`
	OR NEW.`fee_amount` IS NOT OLD.`fee_amount`
	OR NEW.`withholding_amount` IS NOT OLD.`withholding_amount`
	OR NEW.`deposit_account_id` IS NOT OLD.`deposit_account_id`
	OR NEW.`deposit_sub_account_id` IS NOT OLD.`deposit_sub_account_id`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'invoice_payments can only be voided once (immutable otherwise)');
END;
