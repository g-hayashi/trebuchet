import { TAX_CATEGORIES } from "../../src/seed/tax-categories.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import { createEntity } from "../../src/usecases/create-entity.ts";
import { commitFreeeImport, proposeFreeeOpening } from "../../src/usecases/import-freee.ts";
import { replaceOpeningBalances } from "../../src/usecases/masters.ts";
import {
  FixedClock,
  fakeImportUnitOfWork,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "../fakes.ts";
import { FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import { accountIdOfCode } from "../ledger-setup.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

// 取込のユースケース（取消・照合・差分の取込）のテストの共通の準備

export const SHA = "a".repeat(64);
export const NOW = "2026-10-19T00:00:00.000Z";

export function setup() {
  const masters = new InMemoryMasterRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock(NOW);
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "テスト", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
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
  const uow = fakeImportUnitOfWork(ledger, masters);
  const reports = new InMemoryReportRepository(ledger, masters);
  const code = (c: string) => accountIdOfCode(masters, c);
  const masterDeps = { repo: masters, ids, clock };
  return { uow, reports, masters, ledger, ids, clock, code, masterDeps };
}

export type UsecaseSetup = ReturnType<typeof setup>;

export const journalInput = (
  file: string = FIXTURE_FILES.journal,
  overrides: Partial<Parameters<typeof commitFreeeImport>[1]> = {},
) => ({
  bytes: readFixture(file),
  fileName: file,
  sha256: SHA,
  options: {},
  expected: { fileSha256: SHA, countNew: 14 },
  ...overrides,
});

/** 仕訳帳を取り込み、取込の回を返す */
export function commitFixture(
  s: UsecaseSetup,
  overrides: Partial<Parameters<typeof commitFreeeImport>[1]> = {},
) {
  const r = commitFreeeImport(s, journalInput(FIXTURE_FILES.journal, overrides));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 元帳から期首残高の案を作り、そのまま登録する */
export function registerFixtureOpening(s: UsecaseSetup) {
  const proposal = proposeFreeeOpening(s, {
    bytes: readFixture(FIXTURE_FILES.ledger),
    fiscalYear: 2025,
  });
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.error));
  const saved = replaceOpeningBalances(s.masterDeps, 2025, proposal.value.rows);
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
}

export const stateOf = (s: UsecaseSetup) =>
  structuredClone({
    ledger: s.ledger.state,
    masters: s.masters.state,
    imports: s.uow.imports.state,
  });
