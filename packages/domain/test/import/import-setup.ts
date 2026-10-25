import type { PlanImportInput } from "../../src/import/freee/plan.ts";
import type { FreeeJournal, GroupedFreeeJournals } from "../../src/import/freee/read.ts";
import { groupFreeeJournals, readFreeeFile } from "../../src/import/freee/read.ts";
import type { ImportRef } from "../../src/import/types.ts";
import { INDIVIDUAL_ACCOUNTS } from "../../src/seed/accounts.individual.ts";
import { TAX_CATEGORIES } from "../../src/seed/tax-categories.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import type { TaxSettingDraft } from "../../src/tax-settings.ts";
import type { Account, FiscalPeriod, SubAccount } from "../../src/types.ts";
import { makeFiscalPeriod } from "../arbitraries.ts";
import { FIXTURE_FILES } from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";

/** 取込の計画のテストの準備: seed の科目（ID は acc-<コード>）、2025 年度、課税・税込の設定 */

export const accountId = (code: string) => `acc-${code}`;

export const ACCOUNTS: Account[] = INDIVIDUAL_ACCOUNTS.map((s) => ({
  ...s,
  id: accountId(s.code),
  isSystem: true,
  isActive: true,
}));

export const withInactive = (codes: readonly string[]): Account[] =>
  ACCOUNTS.map((a) => (codes.includes(a.code) ? { ...a, isActive: false } : a));

export const PERIOD_2025: FiscalPeriod = makeFiscalPeriod(2025);

/** 課税（一般）・税込。税額を INV-10 で計算する */
const TAXABLE: TaxSettingDraft[] = [
  { effectiveFrom: "2019-01-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
];

export function fixtureJournals(name: string = FIXTURE_FILES.journal): GroupedFreeeJournals {
  const file = readFreeeFile(readFixture(name));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  return groupFreeeJournals(file.value);
}

export function planInput(
  grouped: GroupedFreeeJournals,
  overrides: Partial<PlanImportInput> = {},
): PlanImportInput {
  return {
    journals: grouped.journals,
    rejected: grouped.rejected,
    savedMappings: { accounts: [], taxes: [] },
    accounts: ACCOUNTS,
    subAccounts: [],
    partners: [],
    tags: [],
    periods: [PERIOD_2025],
    taxSettings: TAXABLE,
    taxRates: TAX_RATES,
    taxCategories: TAX_CATEGORIES,
    activeRefs: [],
    manualSignatures: [],
    options: {},
    ...overrides,
  };
}

type LineInput = Partial<FreeeJournal["lines"][number]> &
  Pick<FreeeJournal["lines"][number], "side" | "accountName" | "amount">;

/** 合成の freee の仕訳（名前は NFKC 済みとして渡す） */
export function freeeJournal(
  id: string,
  date: string,
  lines: LineInput[],
  extra: Partial<Omit<FreeeJournal, "lines">> = {},
): FreeeJournal {
  return {
    freeeJournalId: id,
    freeeJournalNo: `no-${id}`,
    date,
    adjustment: false,
    entryMethod: "手動",
    ...extra,
    lines: lines.map((l) => ({
      taxName: "対象外",
      taxAmount: 0,
      tagNames: [],
      description: "",
      ...l,
    })),
  };
}

export const single = (journals: FreeeJournal[]): GroupedFreeeJournals => ({
  journals,
  rejected: [],
});

export function ref(freeeJournalId: string, overrides: Partial<ImportRef> = {}): ImportRef {
  return {
    journalId: `journal-${freeeJournalId}`,
    batchId: "batch-0",
    freeeJournalId,
    freeeJournalNo: null,
    freeeDate: "2025-01-01",
    snapshotJson: "{}",
    revokedAt: null,
    ...overrides,
  };
}

export const sub = (id: string, code: string, name: string, isActive = true): SubAccount => ({
  id,
  accountId: accountId(code),
  name,
  isActive,
});
