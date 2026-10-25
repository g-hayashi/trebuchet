import { type DomainError, err, type Result } from "../types.ts";

/**
 * トランザクションを巻き戻して `err` に直す例外（005 R9）。
 * drizzle のトランザクションは `err` を返しても確定するので、最初の仕訳の書き込みより後で
 * ドメインの判断により中止するときは、これを投げる
 */
export class RollbackError extends Error {
  readonly error: DomainError;

  constructor(error: DomainError) {
    super(error.message);
    this.name = "RollbackError";
    this.error = error;
  }
}

/**
 * UnitOfWork の `transaction` を包み、`RollbackError` を `err` に直す。
 * `RollbackError` 以外の例外は、巻き戻した上でそのまま投げ直す
 */
export function runInTransaction<Tx, T>(
  uow: { transaction<R>(fn: (tx: Tx) => R): R },
  fn: (tx: Tx) => Result<T>,
): Result<T> {
  try {
    return uow.transaction(fn);
  } catch (e) {
    if (e instanceof RollbackError) return err(e.error);
    throw e;
  }
}
