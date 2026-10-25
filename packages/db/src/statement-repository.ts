import type { StatementAuditEntry, StatementStore, StatementUnitOfWork } from "@trebuchet/domain";
import type { TenantConn } from "./internal.ts";
import { statementAuditLog } from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

/**
 * StatementStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 取込・候補・結びつき・ルールなどのメソッドは各ストーリーの db のタスクで足す
 */
export class DrizzleStatementStore implements StatementStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendStatementAudit(entry: StatementAuditEntry): void {
    this.db.insert(statementAuditLog).values(entry).run();
  }
}

/** StatementUnitOfWork の実装。仕訳・マスタ・明細の記録を同じトランザクションで扱う（INV-47） */
export const createStatementUnitOfWork = (db: TenantConn): StatementUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ statements: new DrizzleStatementStore(tx) }));
