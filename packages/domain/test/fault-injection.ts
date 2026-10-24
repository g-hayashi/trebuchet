import type {
  InvoicingStore,
  InvoicingUnitOfWork,
  LedgerRepository,
  MasterRepository,
} from "../src/ports.ts";
import type { FakeInvoicingUnitOfWork } from "./fakes.ts";

/** 書き込みのメソッド（挿入・上書き・追記・置き換え・取消・更新・削除） */
const WRITE_METHOD = /^(insert|upsert|append|replace|void|mark|update|delete)/;

/**
 * 障害の注入（005 INV-32）。UnitOfWork の中で `ledger`・`masters`・`invoicing` の書き込みを数え、
 * `failAt` 回目の書き込みの直前に例外を投げる（`transaction` の中の入れ子の `ledger.transaction` も数える）。
 * 例外は FakeInvoicingUnitOfWork が状態を巻き戻す。`writes` は直近の `transaction` の書き込みの回数
 */
export class FaultInjectingUnitOfWork implements InvoicingUnitOfWork {
  readonly inner: FakeInvoicingUnitOfWork;
  /** 何回目の書き込みで失敗させるか。null なら失敗させない */
  failAt: number | null = null;
  writes = 0;

  constructor(inner: FakeInvoicingUnitOfWork) {
    this.inner = inner;
  }

  transaction<T>(
    fn: (tx: {
      ledger: LedgerRepository;
      masters: MasterRepository;
      invoicing: InvoicingStore;
    }) => T,
  ): T {
    this.writes = 0;
    return this.inner.transaction((tx) =>
      fn({
        ledger: this.wrap(tx.ledger),
        masters: this.wrap(tx.masters),
        invoicing: this.wrap(tx.invoicing),
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
export function snapshotOf(uow: FakeInvoicingUnitOfWork) {
  return structuredClone({
    ledger: uow.ledger.state,
    masters: uow.masters.state,
    invoicing: uow.invoicing.state,
  });
}
