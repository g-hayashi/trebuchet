import type { Result, TenantTx, TenantUnitOfWork } from "@trebuchet/domain";
import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { DrizzleLedgerRepository } from "./ledger-repository.ts";
import { DrizzleMasterRepository } from "./master-repository.ts";
import type * as tenantSchema from "./schema/tenant.ts";

type TenantConn = BaseSQLiteDatabase<"sync", RunResult, typeof tenantSchema>;

/**
 * fn が返した `err` でトランザクションを巻き戻すための例外。drizzle のトランザクションは
 * 例外でしか巻き戻らないので、`run` の中だけで投げて受け止める（外へは出さない）
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
 * TenantUnitOfWork の Drizzle 実装。同じ接続のトランザクションの上に、仕訳・マスタと
 * `extra` が作る機能のストアを作って fn に渡す。fn が `err` を返すか例外を投げると全体を巻き戻す
 */
export function drizzleUnitOfWork<Extra extends object>(
  db: TenantConn,
  extra: (tx: TenantConn) => Extra,
): TenantUnitOfWork<Extra> {
  return {
    run<T>(fn: (tx: TenantTx<Extra>) => Result<T>): Result<T> {
      let signal: RollbackSignal | undefined;
      try {
        return db.transaction((tx) => {
          const result = fn({
            ledger: new DrizzleLedgerRepository(tx),
            masters: new DrizzleMasterRepository(tx),
            ...extra(tx),
          });
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
    },
  };
}
