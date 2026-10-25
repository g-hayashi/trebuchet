import type { TenantTx, TenantUnitOfWork } from "../../src/ports.ts";
import type { Result } from "../../src/types.ts";
import type { InMemoryLedgerRepository } from "./ledger.ts";
import type { InMemoryMasterRepository } from "./master.ts";

/** 状態を `state` に持つフェイクのストア（UnitOfWork が複製して巻き戻す） */
type Stateful = { state: unknown };

/**
 * TenantUnitOfWork のフェイク（db の `drizzleUnitOfWork` と同じ性質）。`run` の前に帳簿・マスタ・
 * ストアの状態を複製し、fn が `err` を返すか例外を投げると、すべてを元に戻す。
 * 同じ UnitOfWork の `run` の中の `run` は例外（db では入れ子のトランザクションにならないため）
 */
export class FakeUnitOfWork<Stores extends Record<string, Stateful>>
  implements TenantUnitOfWork<Stores>
{
  readonly ledger: InMemoryLedgerRepository;
  readonly masters: InMemoryMasterRepository;
  readonly stores: Stores;
  private running = false;

  constructor(ledger: InMemoryLedgerRepository, masters: InMemoryMasterRepository, stores: Stores) {
    this.ledger = ledger;
    this.masters = masters;
    this.stores = stores;
  }

  run<T>(fn: (tx: TenantTx<Stores>) => Result<T>): Result<T> {
    if (this.running) throw new Error("UnitOfWork の run は入れ子にできません");
    const targets: Stateful[] = [this.ledger, this.masters, ...Object.values(this.stores)];
    const snapshot = targets.map((t) => structuredClone(t.state));
    const restore = () => {
      targets.forEach((t, i) => {
        t.state = snapshot[i];
      });
    };
    this.running = true;
    try {
      const result = fn({ ledger: this.ledger, masters: this.masters, ...this.stores });
      if (!result.ok) restore();
      return result;
    } catch (e) {
      restore();
      throw e;
    } finally {
      this.running = false;
    }
  }
}

/** FakeUnitOfWork に、ストアを名前のままのプロパティとして足したもの（`uow.invoicing` など） */
export type FakeUnitOfWorkOf<Stores extends Record<string, Stateful>> = FakeUnitOfWork<Stores> &
  Stores;

export function fakeUnitOfWork<Stores extends Record<string, Stateful>>(
  ledger: InMemoryLedgerRepository,
  masters: InMemoryMasterRepository,
  stores: Stores,
): FakeUnitOfWorkOf<Stores> {
  return Object.assign(new FakeUnitOfWork(ledger, masters, stores), stores);
}
