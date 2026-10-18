-- 手書きのマイグレーション: トリガー・ビュー・参照データ（data-model §2, §4, §5）
CREATE TRIGGER `journals_no_delete` BEFORE DELETE ON `journals`
BEGIN
	SELECT RAISE(ABORT, 'journals cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
-- INV-1, INV-2: 有効な仕訳で、貸借が一致しないもの、または借方・貸方のどちらかの行がないもの
CREATE VIEW `v_unbalanced_journals` AS
SELECT
	j.`id` AS `journal_id`,
	j.`journal_no` AS `journal_no`,
	COALESCE(SUM(CASE WHEN l.`side` = 'debit' THEN l.`amount` END), 0) AS `debit`,
	COALESCE(SUM(CASE WHEN l.`side` = 'credit' THEN l.`amount` END), 0) AS `credit`
FROM `journals` j
LEFT JOIN `journal_lines` l ON l.`journal_id` = j.`id`
WHERE j.`status` = 'active'
GROUP BY j.`id`
HAVING `debit` <> `credit` OR `debit` = 0 OR `credit` = 0;
--> statement-breakpoint
INSERT INTO `tax_categories` (`code`, `name`, `kind`) VALUES
	('OUT_OF_SCOPE', '対象外', NULL),
	('SALES_10', '課税売上10%', 'sales'),
	('SALES_8R', '課税売上8%（軽）', 'sales'),
	('PURCHASE_10', '課対仕入10%', 'purchase'),
	('PURCHASE_8R', '課対仕入8%（軽）', 'purchase'),
	('EXEMPT', '非課税', NULL),
	('NON_TAXABLE', '不課税', NULL);
--> statement-breakpoint
-- 正本は packages/domain/src/seed/tax-rates.ts（一致をテストで確認する）
INSERT INTO `tax_rates` (`category_code`, `rate`, `effective_from`, `source_url`) VALUES
	('SALES_10', 10, '2019-10-01', 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/keigenzeiritsu.htm'),
	('PURCHASE_10', 10, '2019-10-01', 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/keigenzeiritsu.htm'),
	('SALES_8R', 8, '2019-10-01', 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/keigenzeiritsu.htm'),
	('PURCHASE_8R', 8, '2019-10-01', 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/keigenzeiritsu.htm');
