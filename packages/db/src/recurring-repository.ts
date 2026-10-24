import type {
  InvoicingAuditEntry,
  LedgerRepository,
  MasterRepository,
  RecurringStore,
  RecurringUnitOfWork,
} from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { appendInvoicingAuditRow } from "./invoicing-repository.ts";
import { DrizzleLedgerRepository } from "./ledger-repository.ts";
import { DrizzleMasterRepository } from "./master-repository.ts";
import type * as tenantSchema from "./schema/tenant.ts";

/** テナントの DB、またはそのトランザクション */
type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/**
 * RecurringStore の Drizzle（better-sqlite3）による実装。メソッドはすべて同期。
 * 定義・行・回のメソッドは US3 の db のタスクで足す
 */
export class DrizzleRecurringStore implements RecurringStore {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  appendRecurringAudit(entry: InvoicingAuditEntry): void {
    appendInvoicingAuditRow(this.db, entry);
  }
}

/**
 * RecurringUnitOfWork の Drizzle 実装。同じ接続・トランザクションで仕訳・マスタ・定期仕訳の記録を扱う。
 * `transaction` は例外で巻き戻すが、`err` を返しても確定する（R9）
 */
export class DrizzleRecurringUnitOfWork implements RecurringUnitOfWork {
  private readonly db: TenantConn;

  constructor(db: TenantConn) {
    this.db = db;
  }

  transaction<T>(
    fn: (tx: {
      ledger: LedgerRepository;
      masters: MasterRepository;
      recurring: RecurringStore;
    }) => T,
  ): T {
    return this.db.transaction((tx) =>
      fn({
        ledger: new DrizzleLedgerRepository(tx),
        masters: new DrizzleMasterRepository(tx),
        recurring: new DrizzleRecurringStore(tx),
      }),
    );
  }
}
