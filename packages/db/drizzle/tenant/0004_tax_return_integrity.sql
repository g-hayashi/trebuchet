-- 手書きのマイグレーション: 003-tax-return の参照データとトリガー（data-model §1.1, §1.5, §1.10）
-- 正本は packages/domain/src/seed/tax-parameters.ts（一致をテストで確認する）
INSERT INTO `tax_parameters` (`key`, `effective_from`, `effective_to`, `value`, `source_url`) VALUES
	('SMALL_ASSET_THRESHOLD', '2006-04-01', '2026-03-31', 300000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
	('SMALL_ASSET_THRESHOLD', '2026-04-01', '2029-03-31', 400000, 'https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_03.htm'),
	('SMALL_ASSET_ANNUAL_LIMIT', '2006-04-01', '2029-03-31', 3000000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
	('BLUE_DEDUCTION_MAX', '2020-01-01', NULL, 650000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm'),
	('BLUE_DEDUCTION_STANDARD', '2020-01-01', NULL, 550000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm'),
	('BLUE_DEDUCTION_BASIC', '2020-01-01', NULL, 100000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm');
--> statement-breakpoint
CREATE TRIGGER `adjustment_journal_refs_no_delete` BEFORE DELETE ON `adjustment_journal_refs`
BEGIN
	SELECT RAISE(ABORT, 'adjustment_journal_refs cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `closing_audit_log_no_update` BEFORE UPDATE ON `closing_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'closing_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `closing_audit_log_no_delete` BEFORE DELETE ON `closing_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'closing_audit_log is append-only');
END;
