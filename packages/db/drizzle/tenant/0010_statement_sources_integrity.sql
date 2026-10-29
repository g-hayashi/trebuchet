-- 手書きのマイグレーション: 007-generic-statement-import（data-model §2）
-- 0009 が statement_batches・statement_audit_log を作り直した（DROP TABLE でトリガーも消える）ので、
-- 0008_statements_integrity.sql と同じ本文でトリガーを作り直す
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
CREATE TRIGGER `statement_audit_log_no_update` BEFORE UPDATE ON `statement_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'statement_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `statement_audit_log_no_delete` BEFORE DELETE ON `statement_audit_log`
BEGIN
	SELECT RAISE(ABORT, 'statement_audit_log is append-only');
END;
