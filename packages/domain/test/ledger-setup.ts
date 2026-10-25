import { TAX_RATES } from "../src/seed/tax-rates.ts";
import type { Account, Partner } from "../src/types.ts";
import { createEntity } from "../src/usecases/create-entity.ts";
import { createNextFiscalPeriod } from "../src/usecases/masters.ts";
import {
  FixedClock,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";
import { NOW } from "./test-dates.ts";

/** 名前から勘定科目の ID を引く。なければ例外 */
export function accountIdOf(masters: { listAccounts(): Account[] }, name: string): string {
  const account = masters.listAccounts().find((a) => a.name === name);
  if (account === undefined) throw new Error(`科目がない: ${name}`);
  return account.id;
}

/** コードから勘定科目の ID を引く。なければ例外 */
export function accountIdOfCode(masters: { state: { accounts: Account[] } }, code: string): string {
  const account = masters.state.accounts.find((a) => a.code === code);
  if (account === undefined) throw new Error(`科目がない: ${code}`);
  return account.id;
}

/**
 * 請求（005）・定期仕訳（005）のドメインのテストが共有する準備（機能に依存しない部分）:
 * 2025・2026 年度の会計期間（どちらも open）を持つ個人事業。税率は seed を入れる。
 * `taxable` なら 2025-01-01 から課税事業者（税込経理）、省略なら免税事業者
 */
export function setupBase(options: { taxable?: boolean } = {}) {
  const ledger = new InMemoryLedgerRepository();
  const masters = new InMemoryMasterRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock(NOW);
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(created.error.message);
  const next = createNextFiscalPeriod({ repo: masters, ids, clock });
  if (!next.ok) throw new Error(next.error.message);
  masters.state.taxRates = [...TAX_RATES];
  if (options.taxable === true) {
    masters.replaceTaxSettings([
      {
        id: ids.next(),
        effectiveFrom: "2025-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
  }

  const accountId = (name: string) => accountIdOf(masters, name);
  let partnerCount = 0;
  const addPartner = (over: Partial<Partner> = {}): Partner => {
    partnerCount += 1;
    const partner: Partner = {
      id: ids.next(),
      name: `取引先${partnerCount}`,
      honorific: null,
      memo: null,
      isActive: true,
      ...over,
    };
    masters.insertPartner(partner);
    return partner;
  };
  const closeYear = (fiscalYear: number) => {
    const p = masters.getFiscalPeriodByYear(fiscalYear);
    if (p === undefined) throw new Error(`会計期間がない: ${fiscalYear}`);
    masters.updateFiscalPeriod({ ...p, status: "closed", closedAt: NOW });
  };

  return { ledger, masters, ids, clock, accountId, addPartner, closeYear };
}
