import { describe, expect, it } from "vitest";
import { TAX_CATEGORIES } from "../../src/seed/tax-categories.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import { createEntity } from "../../src/usecases/create-entity.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { proposeFreeeOpening } from "../../src/usecases/import-freee.ts";
import {
  addSubAccount,
  createNextFiscalPeriod,
  replaceOpeningBalances,
} from "../../src/usecases/masters.ts";
import {
  FakeImportUnitOfWork,
  FixedClock,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "../fakes.ts";
import { EXPECTED_OPENING_PROPOSAL, FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

const NOW = "2026-10-19T00:00:00.000Z";

function setup(firstFiscalYear = 2025) {
  const masters = new InMemoryMasterRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock(NOW);
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "テスト", kind: "individual", fiscalStartMonth: 1, firstFiscalYear },
  );
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  masters.state.taxRates = [...TAX_RATES];
  masters.state.taxCategories = [...TAX_CATEGORIES];
  masters.replaceTaxSettings([
    {
      id: ids.next(),
      effectiveFrom: "2019-01-01",
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  ]);
  const ledger = new InMemoryLedgerRepository();
  const uow = new FakeImportUnitOfWork(ledger, masters);
  const reports = new InMemoryReportRepository(ledger, masters);
  const code = (c: string) => {
    const a = masters.state.accounts.find((x) => x.code === c);
    if (a === undefined) throw new Error(`科目がない: ${c}`);
    return a.id;
  };
  const masterDeps = { repo: masters, ids, clock };
  const card = () => {
    const sub = addSubAccount(masterDeps, code("2020"), "ABCカード");
    if (!sub.ok) throw new Error(JSON.stringify(sub.error));
    return sub.value;
  };
  return { uow, reports, masters, ledger, ids, clock, code, masterDeps, card };
}

const ledgerBytes = () => readFixture(FIXTURE_FILES.ledger);

describe("proposeFreeeOpening（T043）", () => {
  it("元帳から期首残高の案を作る。帳簿は変えない", () => {
    const s = setup();
    const sub = s.card();
    const before = structuredClone({
      masters: s.masters.state,
      ledger: s.ledger.state,
      imports: s.uow.imports.state,
    });
    const r = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows.map((x) => [x.accountId, x.subAccountId, x.side, x.amount])).toEqual(
      EXPECTED_OPENING_PROPOSAL.map((e) => [
        s.code(e.code),
        e.subAccountName === undefined ? null : sub.id,
        e.side,
        e.amount,
      ]),
    );
    expect(r.value.totals).toEqual({ debit: 1_070_000, credit: 1_070_000 });
    expect(r.value.comparisons.every((c) => c.registered === null && c.carryForward === null)).toBe(
      true,
    );
    expect({
      masters: s.masters.state,
      ledger: s.ledger.state,
      imports: s.uow.imports.state,
    }).toEqual(before);
  });

  it("案の行を 001 の期首残高の一括置換に渡すと保存できる", () => {
    const s = setup();
    s.card();
    const r = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const saved = replaceOpeningBalances(s.masterDeps, 2025, r.value.rows);
    expect(saved.ok).toBe(true);

    // 保存後は登録済みとの差が 0 になる
    const again = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    for (const c of again.value.comparisons) expect(c.registered).toBe(c.proposed);
  });

  it("保存済みの対応表を使う。カードの補助科目がなければ unmapped", () => {
    const s = setup();
    const r = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    expect(r.ok && r.value.unmapped).toEqual(["ABCカード"]);

    s.uow.imports.upsertAccountMappings(
      [{ sourceName: "ABCカード", accountId: s.code("2030") }],
      NOW,
    );
    const mapped = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    expect(mapped.ok && mapped.value.unmapped).toEqual([]);
    expect(mapped.ok && mapped.value.rows.find((x) => x.accountId === s.code("2030"))?.amount).toBe(
      15_000,
    );
  });

  it("仕訳帳 → IMPORT_WRONG_KIND、freee 以外 → IMPORT_UNKNOWN_FORMAT", () => {
    const s = setup();
    const wrong = proposeFreeeOpening(s, {
      bytes: readFixture(FIXTURE_FILES.journal),
      fiscalYear: 2025,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok)
      expect(wrong.error).toMatchObject({
        code: "IMPORT_WRONG_KIND",
        details: { expected: "ledger", actual: "journal" },
      });
    const unknown = proposeFreeeOpening(s, {
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      fiscalYear: 2025,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("IMPORT_UNKNOWN_FORMAT");
  });

  it("会計期間がない年度 → OUT_OF_PERIOD", () => {
    const s = setup();
    const r = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2026 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("OUT_OF_PERIOD");
  });

  it("前年度の仕訳があれば computeBalances の期末から繰越を求めて比べる（FR-020a）。仕訳がなければ比べない", () => {
    const s = setup(2024);
    s.card();
    const next = createNextFiscalPeriod(s.masterDeps);
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    const opening = replaceOpeningBalances(s.masterDeps, 2024, [
      { accountId: s.code("1010"), side: "debit", amount: 30_000 },
      { accountId: s.code("3020"), side: "credit", amount: 30_000 },
    ]);
    if (!opening.ok) throw new Error(JSON.stringify(opening.error));

    // 前年度の期首残高だけで仕訳がない → 比べない
    const none = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!none.ok) throw new Error(JSON.stringify(none.error));
    expect(none.value.comparisons.every((c) => c.carryForward === null)).toBe(true);

    const sale = createJournal(
      { ledger: s.ledger, masters: s.masters, ids: s.ids, clock: s.clock },
      {
        date: "2024-06-01",
        lines: [
          {
            side: "debit",
            accountId: s.code("1020"),
            amount: 800_000,
            taxCategory: "OUT_OF_SCOPE",
          },
          {
            side: "credit",
            accountId: s.code("4010"),
            amount: 800_000,
            taxCategory: "OUT_OF_SCOPE",
          },
        ],
      },
    );
    if (!sale.ok) throw new Error(JSON.stringify(sale.error));
    // 当年度（2025）の仕訳は前年度の期末に含めない
    const later = createJournal(
      { ledger: s.ledger, masters: s.masters, ids: s.ids, clock: s.clock },
      {
        date: "2025-02-01",
        lines: [
          { side: "debit", accountId: s.code("1010"), amount: 5_000, taxCategory: "OUT_OF_SCOPE" },
          { side: "credit", accountId: s.code("4020"), amount: 5_000, taxCategory: "OUT_OF_SCOPE" },
        ],
      },
    );
    if (!later.ok) throw new Error(JSON.stringify(later.error));

    const r = proposeFreeeOpening(s, { bytes: ledgerBytes(), fiscalYear: 2025 });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const cmp = (c: string) =>
      r.value.comparisons.find((x) => x.accountId === s.code(c) && x.subAccountId === null);
    expect(cmp("1010")).toMatchObject({ proposed: 30_000, carryForward: 30_000 });
    expect(cmp("1020")).toMatchObject({ proposed: 800_000, carryForward: 800_000 });
    expect(cmp("3020")).toMatchObject({ proposed: 1_035_000, carryForward: 830_000 });
    const warned = r.value.warnings
      .filter((w) => w.code === "OPENING_DIFFERS_FROM_CARRY_FORWARD")
      .map((w) => w.details?.accountId);
    expect(warned).toEqual([s.code("1030"), s.code("1060"), s.code("2020"), s.code("3020")]);
  });
});
