import type { ReceiptStore, ReceiptUnitOfWork, TenantTx } from "../src/ports.ts";
import type { Result } from "../src/types.ts";
import type { FakeReceiptUnitOfWork } from "./fakes.ts";

/** 書き込みのメソッド（挿入・上書き・追記・置き換え・取消・失効・更新・削除・設定・確認・閉じる） */
const WRITE_METHOD =
  /^(insert|upsert|append|replace|void|mark|update|delete|revoke|set|save|acknowledge|close)/;

/**
 * 障害の注入（010 INV-62。006 の `FaultInjectingStatementUnitOfWork` の証憑版）。UnitOfWork の中で
 * `ledger`・`masters`・`receipts` の書き込みを数え、`failAt` 回目の書き込みの直前に例外を投げる
 * （`run` の中の入れ子の `ledger.transaction` も数える）。例外は FakeUnitOfWork が状態を巻き戻す。
 * `writes` は直近の `run` の書き込みの回数
 */
export class FaultInjectingReceiptUnitOfWork implements ReceiptUnitOfWork {
  readonly inner: FakeReceiptUnitOfWork;
  /** 何回目の書き込みで失敗させるか。null なら失敗させない */
  failAt: number | null = null;
  writes = 0;

  constructor(inner: FakeReceiptUnitOfWork) {
    this.inner = inner;
  }

  run<T>(fn: (tx: TenantTx<{ receipts: ReceiptStore }>) => Result<T>): Result<T> {
    this.writes = 0;
    return this.inner.run((tx) =>
      fn({
        ledger: this.wrap(tx.ledger),
        masters: this.wrap(tx.masters),
        receipts: this.wrap(tx.receipts),
      }),
    );
  }

  private wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (t, prop) => {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== "function" || typeof prop !== "string") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (prop === "transaction") {
          return (fn: (tx: object) => unknown) => method.call(t, (tx: object) => fn(this.wrap(tx)));
        }
        if (!WRITE_METHOD.test(prop)) return method.bind(t);
        return (...args: unknown[]) => {
          this.writes += 1;
          if (this.failAt !== null && this.writes === this.failAt) {
            throw new Error(`injected failure at write #${this.writes} (${prop})`);
          }
          return method.apply(t, args);
        };
      },
    });
  }
}

/** 巻き戻しの比較に使う、UnitOfWork の全状態の複製 */
export function receiptSnapshotOf(uow: FakeReceiptUnitOfWork) {
  return structuredClone({
    ledger: uow.ledger.state,
    masters: uow.masters.state,
    receipts: uow.receipts.state,
  });
}
