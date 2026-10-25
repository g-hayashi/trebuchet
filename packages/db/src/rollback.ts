import type { Result } from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as tenantSchema from "./schema/tenant.ts";

type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/**
 * fn が返した `err` でトランザクションを巻き戻すための例外。drizzle のトランザクションは
 * 例外でしか巻き戻らないので、`inTransaction` の中だけで投げて受け止める（外へは出さない）
 */
class RollbackSignal extends Error {
  readonly result: Result<never>;

  constructor(result: Result<never>) {
    super("rollback");
    this.name = "RollbackSignal";
    this.result = result;
  }
}

/**
 * fn を db の 1 つのトランザクション（入れ子は SAVEPOINT）で実行する。fn が `err` を返すと巻き戻して
 * 同じ `err` を返し、例外を投げると巻き戻して同じ例外を投げ直す。UnitOfWork とリポジトリの
 * `transaction` は、すべてこれを通す
 */
export function inTransaction<T>(db: TenantConn, fn: (tx: TenantConn) => Result<T>): Result<T> {
  let signal: RollbackSignal | undefined;
  try {
    return db.transaction((tx) => {
      const result = fn(tx);
      if (!result.ok) {
        signal = new RollbackSignal(result);
        throw signal;
      }
      return result;
    });
  } catch (e) {
    if (signal !== undefined && e === signal) return signal.result;
    throw e;
  }
}
