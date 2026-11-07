-- 013 源泉徴収（data-model §1.1〜1.4、research R2・R4・R5・R6）。
-- 他の列を参照する CHECK は drizzle-kit が出力せず、表の作り直しは 0006 のトリガーと外部キーの張り直しを伴うため、
-- 0013・0019 と同じく ALTER TABLE ... ADD COLUMN で列と CHECK を足す。
-- 請求の条件: 源泉徴収あり（0 か 1）
ALTER TABLE `partner_billing_terms` ADD COLUMN `withholding` integer NOT NULL DEFAULT 0 CHECK (`withholding` IN (0, 1));--> statement-breakpoint
-- 請求書: 発行時に固定する対象額と税額。0 ≤ withholding_tax ≤ withholding_base ≤ total（base を先に足す。tax の CHECK が base を参照する）
ALTER TABLE `invoices` ADD COLUMN `withholding_base` integer NOT NULL DEFAULT 0 CHECK (`withholding_base` >= 0 AND `withholding_base` <= `total`);--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `withholding_tax` integer NOT NULL DEFAULT 0 CHECK (`withholding_tax` >= 0 AND `withholding_tax` <= `withholding_base`);--> statement-breakpoint
-- 入金の消し込み: 実際に差し引かれた源泉徴収税額
ALTER TABLE `invoice_payments` ADD COLUMN `withholding_amount` integer NOT NULL DEFAULT 0 CHECK (`withholding_amount` >= 0);--> statement-breakpoint
-- INV-38: 請求書の写しは発行後に変えない。0006 の invoices_void_only に withholding_base・withholding_tax を足して作り直す
DROP TRIGGER `invoices_void_only`;--> statement-breakpoint
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
	OR NEW.`withholding_base` IS NOT OLD.`withholding_base`
	OR NEW.`withholding_tax` IS NOT OLD.`withholding_tax`
	OR NEW.`journal_id` IS NOT OLD.`journal_id`
	OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
	SELECT RAISE(ABORT, 'invoices can only be voided once (immutable otherwise)');
END;--> statement-breakpoint
-- tax_parameters の key の CHECK を作り直す（0014 と同じ手順: 最終の名前の表を作って写す。付いたトリガー・外部キーはない）
CREATE TABLE `__old_tax_parameters` AS SELECT * FROM `tax_parameters`;--> statement-breakpoint
DROP TABLE `tax_parameters`;--> statement-breakpoint
CREATE TABLE `tax_parameters` (
	`key` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`value` integer NOT NULL,
	`source_url` text NOT NULL,
	PRIMARY KEY(`key`, `effective_from`),
	CONSTRAINT "tax_parameters_key" CHECK("tax_parameters"."key" IN ('SMALL_ASSET_THRESHOLD', 'SMALL_ASSET_ANNUAL_LIMIT', 'BLUE_DEDUCTION_MAX', 'BLUE_DEDUCTION_STANDARD', 'BLUE_DEDUCTION_BASIC', 'LUMP_SUM_COST_MIN', 'LUMP_SUM_COST_MAX', 'LUMP_SUM_YEARS', 'OPENING_COST_AMORTIZATION_MONTHS', 'RECEIPT_INPUT_CYCLE_MONTHS', 'RECEIPT_INPUT_GRACE_BUSINESS_DAYS', 'RECEIPT_SCAN_MIN_LONG_PX', 'RECEIPT_SCAN_MIN_SHORT_PX', 'WITHHOLDING_THRESHOLD', 'WITHHOLDING_RATE_LOW', 'WITHHOLDING_RATE_HIGH')),
	CONSTRAINT "tax_parameters_value" CHECK("tax_parameters"."value" > 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `tax_parameters`("key", "effective_from", "effective_to", "value", "source_url") SELECT "key", "effective_from", "effective_to", "value", "source_url" FROM `__old_tax_parameters`;--> statement-breakpoint
DROP TABLE `__old_tax_parameters`;--> statement-breakpoint
-- 税制の値（data-model §1.1、research R2）。正本は domain の seed/tax-parameters.ts。既存の行は書き換えない
-- 出典: 2026 年分まで国税庁タックスアンサー No.2795、2027 年分から防衛特別所得税の源泉徴収の Q&A（率は据え置き。万分率）
INSERT INTO `tax_parameters` (`key`, `effective_from`, `effective_to`, `value`, `source_url`) VALUES
	('WITHHOLDING_THRESHOLD', '2013-01-01', '2026-12-31', 1000000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2795.htm'),
	('WITHHOLDING_RATE_LOW', '2013-01-01', '2026-12-31', 1021, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2795.htm'),
	('WITHHOLDING_RATE_HIGH', '2013-01-01', '2026-12-31', 2042, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2795.htm'),
	('WITHHOLDING_THRESHOLD', '2027-01-01', '2047-12-31', 1000000, 'https://www.nta.go.jp/publication/pamph/pdf/0026005-024_03.pdf'),
	('WITHHOLDING_RATE_LOW', '2027-01-01', '2047-12-31', 1021, 'https://www.nta.go.jp/publication/pamph/pdf/0026005-024_03.pdf'),
	('WITHHOLDING_RATE_HIGH', '2027-01-01', '2047-12-31', 2042, 'https://www.nta.go.jp/publication/pamph/pdf/0026005-024_03.pdf');
