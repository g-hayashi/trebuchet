import type { AdjustmentProposal } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { depreciate, proposeDepreciationAdjustment } from "../../src/blue-return/depreciation.ts";
import { assetStartYear } from "../../src/blue-return/straight-line.ts";
import { carryForward } from "../../src/carry-forward.ts";
import { computeBalances } from "../../src/reports/balances.ts";
import { STRAIGHT_LINE_RATES } from "../../src/seed/depreciation-rates.ts";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { FixedAsset, Result } from "../../src/types.ts";
import {
  commitAdjustment,
  getAdjustmentProposals,
  getBlueReturn,
} from "../../src/usecases/blue-return.ts";
import { createEntity } from "../../src/usecases/create-entity.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { createNextFiscalPeriod } from "../../src/usecases/masters.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { straightLineAssetArb } from "../blue-return-arbitraries.ts";
import {
  FixedClock,
  fakeClosingUnitOfWork,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "../fakes.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";
import { NOW } from "../test-dates.ts";

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const params = { rates: STRAIGHT_LINE_RATES, taxParameters: TAX_PARAMETERS };

const debitTotal = (p: AdjustmentProposal) =>
  p.journal.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);

/**
 * firstFiscalYear から years 年度分の会計期間を持つ個人事業の帳簿と、ClosingUnitOfWork のフェイク。
 * 生成した資産の勘定（合成の ID）は、同じコードの帳簿の科目に付け替えて台帳に入れる
 */
function setupBook(rawAsset: FixedAsset) {
  const firstFiscalYear = assetStartYear(rawAsset);
  const masters = new InMemoryMasterRepository();
  const ledger = new InMemoryLedgerRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock(NOW);
  unwrap(
    createEntity(
      { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
      { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear },
    ),
  );
  const accountByCode = (code: string) => {
    const a = masters.listAccounts().find((x) => x.code === code);
    if (a === undefined) throw new Error(`科目がない: ${code}`);
    return a.id;
  };
  const asset: FixedAsset = {
    ...rawAsset,
    assetAccountId: accountByCode(rawAsset.assetAccountId.slice(-4)),
  };
  const uow = fakeClosingUnitOfWork(ledger, masters);
  uow.closing.taxParameters = [...TAX_PARAMETERS];
  uow.closing.straightLineRates = [...STRAIGHT_LINE_RATES];
  uow.closing.upsertFixedAsset(asset);

  const reports = new InMemoryReportRepository(ledger, masters);
  const readDeps = { masters, closing: uow.closing, reports };
  const commitDeps = { uow, reports, ids, clock };
  const ledgerDeps = { ledger, masters, ids, clock };
  const period = (fiscalYear: number) => {
    const p = masters.getFiscalPeriodByYear(fiscalYear);
    if (p === undefined) throw new Error(`会計期間がない: ${fiscalYear}`);
    return p;
  };
  const addYear = () => unwrap(createNextFiscalPeriod({ repo: masters, ids, clock }));
  const proposals = (fiscalYear: number) =>
    unwrap(getAdjustmentProposals(readDeps, { fiscalYear }));
  const commit = (fiscalYear: number, amount: number) =>
    commitAdjustment(commitDeps, {
      fiscalYear,
      kind: "depreciation",
      sourceId: asset.id,
      expected: { amount },
    });
  /** その資産・年度の有効な（取り消されていない）償却の仕訳 */
  const activeJournals = (fiscalYear: number) =>
    uow.closing
      .listAdjustmentRefsBySource({ assetId: asset.id })
      .filter((r) => r.kind === "depreciation" && r.fiscalYear === fiscalYear)
      .map((r) => ledger.getJournal(r.journalId))
      .filter((j) => j !== undefined && j.status === "active");

  return {
    asset,
    masters,
    ledger,
    ids,
    firstFiscalYear,
    ledgerDeps,
    readDeps,
    period,
    addYear,
    proposals,
    commit,
    activeJournals,
    accountByCode,
  };
}

/** 最初の年度の期首: 取得が年度より前なら台帳の期首の未償却残高、年度中なら取得の仕訳 */
function openFirstYear(book: ReturnType<typeof setupBook>) {
  const { asset, firstFiscalYear } = book;
  const capital = book.accountByCode("3020");
  if (asset.acquiredOn < `${firstFiscalYear}-01-01`) {
    const amount = unwrap(depreciate(asset, firstFiscalYear, params)).openingBookValue;
    if (amount === 0) return;
    const fiscalPeriodId = book.period(firstFiscalYear).id;
    book.masters.replaceOpeningBalances(fiscalPeriodId, [
      {
        id: book.ids.next(),
        fiscalPeriodId,
        accountId: asset.assetAccountId,
        subAccountId: null,
        side: "debit",
        amount,
      },
      {
        id: book.ids.next(),
        fiscalPeriodId,
        accountId: capital,
        subAccountId: null,
        side: "credit",
        amount,
      },
    ]);
    return;
  }
  unwrap(
    createJournal(book.ledgerDeps, {
      date: asset.acquiredOn,
      memo: "取得",
      lines: [
        { side: "debit", accountId: asset.assetAccountId, amount: asset.acquisitionCost },
        { side: "credit", accountId: capital, amount: asset.acquisitionCost },
      ],
    }),
  );
}

/** 前の年度の期末残高を繰り越して、次の年度の会計期間と期首残高を作る */
function carryToNextYear(book: ReturnType<typeof setupBook>) {
  const next = book.addYear();
  const prior = book.period(next.fiscalYear - 1);
  const balances = computeBalances({
    opening: book.readDeps.reports.openingBalances(prior.fiscalYear),
    lines: book.readDeps.reports.linesInRange(prior.startDate, prior.endDate),
    periodStart: prior.startDate,
    to: prior.endDate,
  });
  const rows = unwrap(carryForward(balances, book.masters.listAccounts()));
  book.masters.replaceOpeningBalances(
    next.id,
    rows.map((r) => ({ id: book.ids.next(), fiscalPeriodId: next.id, ...r })),
  );
}

const YEARS_CHECKED = 7;

describe("INV-59: 案をすべて登録して繰り越した帳簿は、帳簿と台帳が一致する", () => {
  it("定額法の資産を供用の年度から毎年登録して繰り越すと、どの年度も ASSET_REGISTER_MISMATCH・DEPRECIATION_MISMATCH が出ない", () => {
    fc.assert(
      fc.property(straightLineAssetArb, (rawAsset) => {
        const book = setupBook(rawAsset);
        openFirstYear(book);
        const disposalYear =
          book.asset.disposedOn === null ? null : Number(book.asset.disposedOn.slice(0, 4));
        const last = Math.min(
          book.firstFiscalYear + YEARS_CHECKED,
          disposalYear === null ? Number.POSITIVE_INFINITY : disposalYear + 1,
        );
        for (let year = book.firstFiscalYear; year <= last; year++) {
          if (year > book.firstFiscalYear) carryToNextYear(book);
          for (const p of book.proposals(year)) {
            unwrap(book.commit(year, debitTotal(p)));
          }
          expect(book.proposals(year)).toEqual([]);
          const warnings = unwrap(getBlueReturn(book.readDeps, { fiscalYear: year }))
            .warnings.filter(
              (w) => w.code === "ASSET_REGISTER_MISMATCH" || w.code === "DEPRECIATION_MISMATCH",
            )
            .map((w) => [year, w.code, w.details]);
          expect(warnings).toEqual([]);
        }
      }),
      { numRuns: 60 },
    );
  });
});

type Op = { op: "commit" | "void"; offset: number };

describe("INV-60: どの（資産, 年度）でも有効な償却の仕訳は高々 1 件", () => {
  it("確定と取消を任意の順に繰り返しても、有効な仕訳は高々 1 件で、案はそれがないときだけ出る。2 回目の確定は ADJUSTMENT_NOT_NEEDED", () => {
    const opArb: fc.Arbitrary<Op> = fc.record({
      op: fc.constantFrom<"commit" | "void">("commit", "void"),
      offset: fc.integer({ min: 0, max: 2 }),
    });
    fc.assert(
      fc.property(
        straightLineAssetArb,
        fc.array(opArb, { minLength: 1, maxLength: 10 }),
        (rawAsset, ops) => {
          const book = setupBook(rawAsset);
          book.addYear();
          book.addYear();
          const years = [0, 1, 2].map((o) => book.firstFiscalYear + o);
          const accounts = book.masters.listAccounts();

          const check = () => {
            for (const year of years) {
              const active = book.activeJournals(year).length;
              expect(active).toBeLessThanOrEqual(1);
              const listed = book.proposals(year).some((p) => p.sourceId === book.asset.id);
              const possible =
                unwrap(proposeDepreciationAdjustment(book.asset, year, accounts, params)) !== null;
              expect(listed, `${year}`).toBe(active === 0 && possible);
            }
          };

          for (const { op, offset } of ops) {
            const year = book.firstFiscalYear + offset;
            if (op === "commit") {
              const proposal = book.proposals(year).find((p) => p.sourceId === book.asset.id);
              if (proposal !== undefined) {
                unwrap(book.commit(year, debitTotal(proposal)));
              }
              // 登録の後（または案がないとき）の確定は ADJUSTMENT_NOT_NEEDED で何も書かない
              const count = book.ledger.journals.length;
              const again = book.commit(year, proposal === undefined ? 1 : debitTotal(proposal));
              expect(!again.ok && again.error.code).toBe("ADJUSTMENT_NOT_NEEDED");
              if (proposal !== undefined && !again.ok) {
                expect(again.error.details?.reason).toBe("ALREADY_REGISTERED");
              }
              expect(book.ledger.journals.length).toBe(count);
            } else {
              const [journal] = book.activeJournals(year);
              if (journal !== undefined) {
                unwrap(
                  voidJournal(book.ledgerDeps, journal.id, {
                    reason: "やり直し",
                    version: journal.version,
                  }),
                );
              }
            }
            check();
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
