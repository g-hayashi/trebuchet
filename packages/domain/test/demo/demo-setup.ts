import type { DemoAssets, RegistryRepository } from "../../src/ports.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import { domainError, type EntitySummary, err, type Result } from "../../src/types.ts";
import type { DemoEntityDeps, DemoTenantDeps } from "../../src/usecases/demo-entity.ts";
import {
  FakeReceiptFileStore,
  FakeReceiptStore,
  FixedClock,
  fakeClosingUnitOfWork,
  fakeInvoicingUnitOfWork,
  fakeReceiptUnitOfWork,
  fakeRecurringUnitOfWork,
  fakeStatementUnitOfWork,
  InMemoryClosingStore,
  InMemoryInvoicingStore,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRecurringStore,
  InMemoryRegistry,
  InMemoryStatementStore,
  SequentialIds,
} from "../fakes.ts";
import { jpegBytes, pngBytes } from "../fixtures/receipts/sample-files.ts";

/** 注入する失敗。`at` は、投入のユースケースの `run`・`transaction` の呼び出しの通し番号（1 から） */
export type Fault = { at: number; mode: "err" | "throw" };

/**
 * 呼び出しの回数を数え、`fault.at` 回目の `method` の呼び出しで、中身を実行せずに `err` を返すか例外を投げる。
 * 他のメソッド・プロパティはそのまま通す
 */
function guard<T extends object>(
  target: T,
  method: "run" | "transaction",
  counter: { n: number },
  fault: Fault | undefined,
): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== method) return fn.bind(t);
      return (...args: unknown[]) => {
        counter.n += 1;
        if (fault !== undefined && counter.n === fault.at) {
          if (fault.mode === "throw") throw new Error("injected failure");
          const failed: Result<never> = err(domainError("VALIDATION", "injected failure"));
          return failed;
        }
        return fn.apply(t, args);
      };
    },
  });
}

/**
 * 1 つのテナント（単一の帳簿・マスタ）に、デモの全ユースケースの偽の UnitOfWork・ストアをつなぐ。
 * `createEntity` の `openTenant` は同じマスタを返す（事業体は 1 つだけ作る前提）。
 * `tenantFiles`・`files`・`registry` は、後片づけ（`purgeEntityData`）の確認用
 */
export function setupDemo(
  options: {
    now?: string;
    fault?: Fault;
    /** 登録の `insertEntity` で例外（createEntity の最後の段階の失敗） */
    failOnInsert?: boolean;
    /** `activateEntity` で例外 */
    failOnActivate?: boolean;
    /** `purgeEntityData` で例外 */
    failOnPurge?: boolean;
    archived?: EntitySummary[];
  } = {},
) {
  const ledger = new InMemoryLedgerRepository();
  const masters = new InMemoryMasterRepository();
  masters.state.taxRates = [...TAX_RATES];
  const ids = new SequentialIds();
  const clock = new FixedClock(options.now ?? "2026-11-08T03:00:00.000Z");
  const counter = { n: 0 };

  const registry = new InMemoryRegistry();
  registry.failOnInsert = options.failOnInsert ?? false;
  const activated: string[] = [];
  const registryPort: RegistryRepository = {
    listEntities: () => registry.listEntities(),
    getEntity: (id) => registry.getEntity(id),
    insertEntity: (e) => registry.insertEntity(e),
    renameEntity: (id, name) => registry.renameEntity(id, name),
    activateEntity: (id) => {
      if (options.failOnActivate) throw new Error("injected failure: activate");
      activated.push(id);
      registry.activateEntity(id);
    },
    listPreparingEntities: () => registry.listPreparingEntities(),
  };

  const closing = new InMemoryClosingStore(ledger);
  closing.taxParameters = [...TAX_PARAMETERS];
  closing.straightLineRates = [...STRAIGHT_LINE_RATES];
  const closingUow = fakeClosingUnitOfWork(ledger, masters, closing);
  const invoicingUow = fakeInvoicingUnitOfWork(ledger, masters, new InMemoryInvoicingStore());
  const recurringUow = fakeRecurringUnitOfWork(ledger, masters, new InMemoryRecurringStore());
  const receiptUow = fakeReceiptUnitOfWork(ledger, masters, new FakeReceiptStore());
  const statementUow = fakeStatementUnitOfWork(ledger, masters, new InMemoryStatementStore());
  const files = new FakeReceiptFileStore();
  const fault = options.fault;

  const tenantDeps: DemoTenantDeps = {
    masters: { repo: guard(masters, "transaction", counter, fault), ids, clock },
    journals: { ledger: guard(ledger, "transaction", counter, fault), masters, ids, clock },
    closing: { uow: guard(closingUow, "run", counter, fault), ids, clock },
    invoicing: { uow: guard(invoicingUow, "run", counter, fault), ids, clock },
    recurring: { uow: guard(recurringUow, "run", counter, fault), ids, clock },
    receipts: {
      uow: guard(receiptUow, "run", counter, fault),
      files,
      clock,
      ids,
      dateOf: (iso) => iso.slice(0, 10),
    },
    statements: { uow: guard(statementUow, "run", counter, fault), ids, clock },
  };

  /** 作ったテナントの DB ファイルの代わり（`openTenant` で入り、`purgeEntityData` で消える） */
  const tenantFiles = new Set<string>();
  const purged: string[] = [];
  const tenantCalls: string[] = [];
  /** 投入の最初の段階で、準備中の事業体が一覧に出ていないことを確かめるための記録 */
  const visibleWhilePreparing: number[] = [];

  const assets: DemoAssets = {
    receiptImage: (key) =>
      key === "receipt-06"
        ? pngBytes({ seed: 6 })
        : jpegBytes({ seed: key === "receipt-05" ? 5 : 1 }),
    // 寸法は key ごとに違う値（証憑に保存されることを確かめる）。receipt-05 は調べられなかった例（null）
    receiptProbe: (key) =>
      key === "receipt-05"
        ? null
        : { width: key === "receipt-06" ? 600 : 800, height: 400, fullColor: true },
  };

  const deps: DemoEntityDeps = {
    create: {
      registry: registryPort,
      openTenant: (entityId) => {
        tenantFiles.add(entityId);
        return masters;
      },
      ids,
      clock,
    },
    entities: {
      purgeEntityData: (id) => {
        purged.push(id);
        if (options.failOnPurge) throw new Error("injected failure: purge");
        tenantFiles.delete(id);
        files.files.clear();
        registry.entities = registry.entities.filter((e) => e.id !== id);
        registry.statuses.delete(id);
      },
      listArchivedEntities: () => options.archived ?? [],
    },
    tenant: (entityId) => {
      tenantCalls.push(entityId);
      visibleWhilePreparing.push(registry.listEntities().length);
      return tenantDeps;
    },
    assets,
  };

  return {
    deps,
    registry,
    ledger,
    masters,
    closing,
    invoicing: invoicingUow.invoicing,
    recurring: recurringUow.recurring,
    receipts: receiptUow.receipts,
    statements: statementUow.statements,
    files,
    tenantFiles,
    purged,
    tenantCalls,
    activated,
    visibleWhilePreparing,
    counter,
  };
}

export type DemoSetup = ReturnType<typeof setupDemo>;
