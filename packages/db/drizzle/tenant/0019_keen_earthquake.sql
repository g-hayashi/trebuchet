-- 011/R9・T018: ルールの管理の主体。`user` は利用者が直した・止めたルールで、承認の学びと初期作成は変えない。
-- drizzle-kit は CHECK の追加で表を作り直す（UNIQUE の式のインデックスを落とし、新しい列を旧表から SELECT して失敗する）ため、
-- 0013 と同じく ALTER TABLE で列を足す
ALTER TABLE `inference_rules` ADD COLUMN `managed_by` text NOT NULL DEFAULT 'auto' CHECK (`managed_by` IN ('auto', 'user'));
