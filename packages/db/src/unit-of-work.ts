import type { Result, TenantTx, TenantUnitOfWork } from "@trebuchet/domain";
import type { TenantConn } from "./internal.ts";
import { DrizzleLedgerRepository } from "./ledger-repository.ts";
import { DrizzleMasterRepository } from "./master-repository.ts";
import { inTransaction } from "./rollback.ts";

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
      return inTransaction(db, (tx) =>
        fn({
          ledger: new DrizzleLedgerRepository(tx),
          masters: new DrizzleMasterRepository(tx),
          ...extra(tx),
        }),
      );
    },
  };
}
