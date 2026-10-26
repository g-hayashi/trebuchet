import type { StatementStore, StatementUnitOfWork, TenantTx } from "../src/ports.ts";
import type { Result } from "../src/types.ts";
import type { FakeStatementUnitOfWork } from "./fakes.ts";

/** 書き込みのメソッド（挿入・上書き・追記・置き換え・取消・失効・更新・削除・設定・確認） */
const WRITE_METHOD =
  /^(insert|upsert|append|replace|void|mark|update|delete|revoke|set|save|acknowledge)/;

/**
 * 障害の注入（006 INV-47。005 の `FaultInjectingUnitOfWork` の明細版）。UnitOfWork の中で
 * `ledger`・`masters`・`statements` の書き込みを数え、`failAt` 回目の書き込みの直前に例外を投げる
 * （`run` の中の入れ子の `ledger.transaction` も数える）。例外は FakeUnitOfWork が状態を巻き戻す。
 * `writes` は直近の `run` の書き込みの回数
 */
export class FaultInjectingStatementUnitOfWork implements StatementUnitOfWork {
  readonly inner: FakeStatementUnitOfWork;
  /** 何回目の書き込みで失敗させるか。null なら失敗させない */
  failAt: number | null = null;
  writes = 0;

  constructor(inner: FakeStatementUnitOfWork) {
    this.inner = inner;
  }

  run<T>(fn: (tx: TenantTx<{ statements: StatementStore }>) => Result<T>): Result<T> {
    this.writes = 0;
    return this.inner.run((tx) =>
      fn({
        ledger: this.wrap(tx.ledger),
        masters: this.wrap(tx.masters),
        statements: this.wrap(tx.statements),
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
export function snapshotOf(uow: FakeStatementUnitOfWork) {
  return structuredClone({
    ledger: uow.ledger.state,
    masters: uow.masters.state,
    statements: uow.statements.state,
  });
}
