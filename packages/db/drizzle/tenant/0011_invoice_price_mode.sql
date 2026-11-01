-- 005/R27: 請求の入力方式と消費税相当額。-1 は税率の自動導出、NULL は明示した税率なし。
ALTER TABLE `partner_billing_terms` ADD COLUMN `price_mode` text NOT NULL DEFAULT 'inclusive' CHECK (`price_mode` IN ('inclusive', 'exclusive'));
--> statement-breakpoint
ALTER TABLE `partner_billing_terms` ADD COLUMN `tax_rate` integer DEFAULT -1 CHECK (`tax_rate` IS NULL OR `tax_rate` IN (-1, 8, 10));
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `price_mode` text NOT NULL DEFAULT 'inclusive' CHECK (`price_mode` IN ('inclusive', 'exclusive'));
--> statement-breakpoint
CREATE TRIGGER `invoices_price_mode_immutable` BEFORE UPDATE OF `price_mode` ON `invoices`
WHEN NEW.`price_mode` IS NOT OLD.`price_mode`
BEGIN
  SELECT RAISE(ABORT, 'invoice price mode snapshot is immutable');
END;
