-- 手書きのマイグレーション: 009-depreciation-deferred の参照データとトリガー（data-model §1.1・§1.2・§1.5・§1.6・§1.7、research R14）
-- 正本は packages/domain/src/seed/depreciation-rates.ts と seed/tax-parameters.ts（一致をテストで確認する）
-- 定額法の償却率（2007-04-01 以後の取得、耐用年数省令 別表第八。千分率）
INSERT INTO `straight_line_rates` (`useful_life_years`, `effective_from`, `effective_to`, `rate_permille`, `source_url`) VALUES
	(2, '2007-04-01', NULL, 500, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(3, '2007-04-01', NULL, 334, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(4, '2007-04-01', NULL, 250, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(5, '2007-04-01', NULL, 200, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(6, '2007-04-01', NULL, 167, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(7, '2007-04-01', NULL, 143, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(8, '2007-04-01', NULL, 125, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(9, '2007-04-01', NULL, 112, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(10, '2007-04-01', NULL, 100, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(11, '2007-04-01', NULL, 91, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(12, '2007-04-01', NULL, 84, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(13, '2007-04-01', NULL, 77, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(14, '2007-04-01', NULL, 72, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(15, '2007-04-01', NULL, 67, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(16, '2007-04-01', NULL, 63, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(17, '2007-04-01', NULL, 59, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(18, '2007-04-01', NULL, 56, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(19, '2007-04-01', NULL, 53, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(20, '2007-04-01', NULL, 50, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(21, '2007-04-01', NULL, 48, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(22, '2007-04-01', NULL, 46, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(23, '2007-04-01', NULL, 44, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(24, '2007-04-01', NULL, 42, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(25, '2007-04-01', NULL, 40, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(26, '2007-04-01', NULL, 39, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(27, '2007-04-01', NULL, 38, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(28, '2007-04-01', NULL, 36, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(29, '2007-04-01', NULL, 35, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(30, '2007-04-01', NULL, 34, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(31, '2007-04-01', NULL, 33, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(32, '2007-04-01', NULL, 32, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(33, '2007-04-01', NULL, 31, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(34, '2007-04-01', NULL, 30, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(35, '2007-04-01', NULL, 29, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(36, '2007-04-01', NULL, 28, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(37, '2007-04-01', NULL, 28, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(38, '2007-04-01', NULL, 27, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(39, '2007-04-01', NULL, 26, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(40, '2007-04-01', NULL, 25, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(41, '2007-04-01', NULL, 25, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(42, '2007-04-01', NULL, 24, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(43, '2007-04-01', NULL, 24, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(44, '2007-04-01', NULL, 23, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(45, '2007-04-01', NULL, 23, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(46, '2007-04-01', NULL, 22, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(47, '2007-04-01', NULL, 22, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(48, '2007-04-01', NULL, 21, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(49, '2007-04-01', NULL, 21, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf'),
	(50, '2007-04-01', NULL, 20, 'https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf');
--> statement-breakpoint
-- 一括償却資産と開業費の税制の値（research R13）。既存の行は書き換えない
INSERT INTO `tax_parameters` (`key`, `effective_from`, `effective_to`, `value`, `source_url`) VALUES
	('LUMP_SUM_COST_MIN', '2007-04-01', NULL, 100000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
	('LUMP_SUM_COST_MAX', '2007-04-01', NULL, 200000, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
	('LUMP_SUM_YEARS', '2007-04-01', NULL, 3, 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm'),
	('OPENING_COST_AMORTIZATION_MONTHS', '2007-04-01', NULL, 60, 'https://www.nta.go.jp/law/shitsugi/shotoku/04/08.htm');
--> statement-breakpoint
-- 0011 の表の作り直しで消えたトリガーを作り直す（本文は 0004_tax_return_integrity.sql と同じ）
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
--> statement-breakpoint
-- 開業費の年度ごとの決定は更新できる（金額の変更）が、削除はしない（0 円の決定も記録として残す。R5）
CREATE TRIGGER `deferred_amortizations_no_delete` BEFORE DELETE ON `deferred_amortizations`
BEGIN
	SELECT RAISE(ABORT, 'deferred_amortizations cannot be deleted');
END;
