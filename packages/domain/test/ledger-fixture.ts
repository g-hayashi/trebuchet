import type { FiscalPeriod, JournalDraft, LineDraft } from "../src/types.ts";
import { createEntity } from "../src/usecases/create-entity.ts";
import { createJournal } from "../src/usecases/create-journal.ts";
import { createNextFiscalPeriod } from "../src/usecases/masters.ts";
import {
  FixedClock,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";

/**
 * 訂正・取消のテスト（US3）の準備: 2025 年度と 2026 年度の会計期間（どちらも open）を持つ個人事業。
 * closeYear で会計期間を締め済みにする（締めの操作は US5 で実装する）
 */
export function setupLedger() {
  const masters = new InMemoryMasterRepository();
  const ledger = new InMemoryLedgerRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock("2026-10-31T09:00:00.000Z");
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(created.error.message);
  const next = createNextFiscalPeriod({ repo: masters, ids, clock });
  if (!next.ok) throw new Error(next.error.message);
  const deps = { ledger, masters, ids, clock };

  const accountId = (name: string) => {
    const a = masters.listAccounts().find((x) => x.name === name);
    if (a === undefined) throw new Error(`科目がない: ${name}`);
    return a.id;
  };
  const line = (side: LineDraft["side"], name: string, amount: number): LineDraft => ({
    side,
    accountId: accountId(name),
    amount,
  });
  const sale = (amount = 495_000, date = "2026-10-31"): JournalDraft => ({
    date,
    memo: "10月分",
    lines: [line("debit", "売掛金", amount), line("credit", "売上高", amount)],
  });
  const period = (fiscalYear: number): FiscalPeriod => {
    const p = masters.getFiscalPeriodByYear(fiscalYear);
    if (p === undefined) throw new Error(`会計期間がない: ${fiscalYear}`);
    return p;
  };
  const closeYear = (fiscalYear: number) =>
    masters.updateFiscalPeriod({
      ...period(fiscalYear),
      status: "closed",
      closedAt: "2026-03-15T00:00:00.000Z",
    });
  /** 仕訳を登録して返す（失敗したら例外） */
  const create = (draft: JournalDraft = sale()) => {
    const r = createJournal(deps, draft);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value.journal;
  };

  return { masters, ledger, ids, clock, deps, accountId, line, sale, period, closeYear, create };
}
