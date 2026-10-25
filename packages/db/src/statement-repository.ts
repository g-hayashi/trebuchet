import type {
  StatementAuditEntry,
  StatementRecord,
  StatementStore,
  StatementUnitOfWork,
} from "@trebuchet/domain";
import type { StatementAccount, StatementBatch } from "@trebuchet/schema";
import { asc, desc, eq } from "drizzle-orm";
import { insertionOrder, type TenantConn } from "./internal.ts";
import {
  statementAccounts,
  statementAuditLog,
  statementBatches,
  statements,
} from "./schema/tenant.ts";
import { drizzleUnitOfWork } from "./unit-of-work.ts";

type StatementRow = typeof statements.$inferSelect;

const toRecord = (row: StatementRow): StatementRecord => ({
  ...row,
  transferFlag: row.transferFlag === 1,
});

const toRow = (record: StatementRecord): StatementRow => ({
  ...record,
  transferFlag: record.transferFlag ? 1 : 0,
});

/**
 * StatementStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 候補・結びつき・ルールなどのメソッドは各ストーリーの db のタスクで足す
 */
export class DrizzleStatementStore implements StatementStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendStatementAudit(entry: StatementAuditEntry): void {
    this.db.insert(statementAuditLog).values(entry).run();
  }

  listStatementAccounts(): StatementAccount[] {
    return this.db.select().from(statementAccounts).orderBy(asc(statementAccounts.name)).all();
  }

  upsertStatementAccount(account: StatementAccount): void {
    const { id: _id, createdAt: _createdAt, ...changes } = account;
    this.db
      .insert(statementAccounts)
      .values(account)
      .onConflictDoUpdate({ target: statementAccounts.id, set: changes })
      .run();
  }

  insertStatementBatch(batch: StatementBatch): void {
    this.db.insert(statementBatches).values(batch).run();
  }

  listStatementBatches(): StatementBatch[] {
    return this.db
      .select()
      .from(statementBatches)
      .orderBy(desc(statementBatches.createdAt), desc(statementBatches.id))
      .all();
  }

  insertStatements(rows: StatementRecord[]): void {
    for (const row of rows) this.db.insert(statements).values(toRow(row)).run();
  }

  listStatements(): StatementRecord[] {
    return this.db.select().from(statements).orderBy(insertionOrder).all().map(toRecord);
  }

  markStatementChanged(id: string, changedJson: string): void {
    const result = this.db
      .update(statements)
      .set({ changedJson, changedAckAt: null })
      .where(eq(statements.id, id))
      .run();
    if (result.changes === 0) throw new Error(`statement not found: ${id}`);
  }
}

/** StatementUnitOfWork の実装。仕訳・マスタ・明細の記録を同じトランザクションで扱う（INV-47） */
export const createStatementUnitOfWork = (db: TenantConn): StatementUnitOfWork =>
  drizzleUnitOfWork(db, (tx) => ({ statements: new DrizzleStatementStore(tx) }));
