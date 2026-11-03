import type { JournalDraft as SavedJournalInput, TaxCategoryCode } from "@trebuchet/schema";
import fc from "fast-check";
import type { CarryForwardBalance } from "../src/carry-forward.ts";
import type {
  Account,
  AccountCategory,
  FiscalPeriod,
  LineDraft,
  ReportSection,
  Side,
} from "../src/types.ts";

/** fast-check のジェネレーター。他パッケージのテストからは `@trebuchet/domain/testing` で使う */

/** テストの「今」の時刻・日付（正本は test-dates.ts） */
export { NOW, TODAY } from "./test-dates.ts";
/** fast-check を依存に持たないパッケージ（db）のテスト用に再エクスポートする */
export { fc };

/** 011/INV-69: 未完成の入力を含む、保存用の下書き。仕訳の案の型とは別。 */
export const journalDraftArb: fc.Arbitrary<SavedJournalInput> = fc.record({
  mode: fc.constantFrom("quick" as const, "detailed" as const),
  date: fc.option(fc.string(), { nil: null }),
  memo: fc.string({ maxLength: 1000 }),
  partnerId: fc.option(fc.string(), { nil: null }),
  tagIds: fc.array(fc.string()),
  lines: fc.array(
    fc.record({
      side: fc.constantFrom("debit" as const, "credit" as const),
      accountId: fc.option(fc.string(), { nil: null }),
      subAccountId: fc.option(fc.string(), { nil: null }),
      amount: fc.option(fc.integer(), { nil: null }),
      taxCategory: fc.option(fc.string(), { nil: null }),
      partnerId: fc.option(fc.string(), { nil: null }),
      tagIds: fc.array(fc.string()),
      description: fc.option(fc.string(), { nil: null }),
    }),
    { maxLength: 50 },
  ),
});

const NORMAL_SIDE: Record<AccountCategory, Side> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

const SECTION: Record<AccountCategory, ReportSection> = {
  asset: "BS_ASSET",
  liability: "BS_LIABILITY",
  equity: "BS_EQUITY",
  revenue: "PL_SALES",
  expense: "PL_EXPENSE",
};

const CATEGORIES: AccountCategory[] = ["asset", "liability", "equity", "revenue", "expense"];

let accountSeq = 0;
const syntheticId = (prefix: string, n: number) =>
  `${prefix}-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export function makeAccount(category: AccountCategory, overrides: Partial<Account> = {}): Account {
  accountSeq += 1;
  return {
    id: syntheticId("0000000a", accountSeq),
    code: `T${accountSeq}`,
    name: `${category}-${accountSeq}`,
    category,
    normalSide: NORMAL_SIDE[category],
    reportSection: SECTION[category],
    reportLine: null,
    sortOrder: accountSeq,
    isSystem: false,
    isActive: true,
    ...overrides,
  };
}

/** 各区分を1つ以上含む、有効な科目のセット */
export const accountSetArb: fc.Arbitrary<Account[]> = fc
  .array(fc.constantFrom(...CATEGORIES), { maxLength: 10 })
  .map((extra) => [...CATEGORIES, ...extra].map((c) => makeAccount(c)));

export const amountArb = fc.integer({ min: 1, max: 1_000_000_000 });

/**
 * 合計が total になる正の整数の分割（count 個）。
 * total >= count を前提とする。
 */
function splitArb(total: number, count: number): fc.Arbitrary<number[]> {
  if (count === 1) return fc.constant([total]);
  return fc
    .uniqueArray(fc.integer({ min: 1, max: total - 1 }), {
      minLength: count - 1,
      maxLength: count - 1,
    })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), total];
      return points.slice(1).map((p, i) => p - (points[i] ?? 0));
    });
}

/** 貸借が一致する行（2〜8行、借方・貸方とも1行以上） */
export function balancedLinesArb(accounts: readonly Account[]): fc.Arbitrary<LineDraft[]> {
  const accountIdArb = fc.constantFrom(...accounts.map((a) => a.id));
  return fc
    .record({
      debitCount: fc.integer({ min: 1, max: 4 }),
      creditCount: fc.integer({ min: 1, max: 4 }),
      total: fc.integer({ min: 8, max: 1_000_000_000 }),
    })
    .chain(({ debitCount, creditCount, total }) =>
      fc.tuple(
        splitArb(total, debitCount),
        splitArb(total, creditCount),
        fc.array(accountIdArb, { minLength: debitCount, maxLength: debitCount }),
        fc.array(accountIdArb, { minLength: creditCount, maxLength: creditCount }),
      ),
    )
    .map(([debits, credits, debitAccounts, creditAccounts]) => [
      ...debits.map((amount, i) => line("debit", debitAccounts[i], amount)),
      ...credits.map((amount, i) => line("credit", creditAccounts[i], amount)),
    ]);
}

function line(side: Side, accountId: string | undefined, amount: number): LineDraft {
  if (accountId === undefined) throw new Error("accountId is undefined");
  const taxCategory: TaxCategoryCode = "OUT_OF_SCOPE";
  return { side, accountId, amount, taxCategory };
}

export type OpeningRow = { accountId: string; side: Side; amount: number };

/** 貸借が一致する期首残高（科目は重複しない） */
export function balancedOpeningArb(accounts: readonly Account[]): fc.Arbitrary<OpeningRow[]> {
  return fc.shuffledSubarray([...accounts], { minLength: 2 }).chain((picked) => {
    const debitCount = Math.max(1, Math.floor(picked.length / 2));
    const creditCount = picked.length - debitCount;
    return fc
      .integer({ min: Math.max(debitCount, creditCount), max: 1_000_000_000 })
      .chain((total) => fc.tuple(splitArb(total, debitCount), splitArb(total, creditCount)))
      .map(([debits, credits]) => [
        ...debits.map((amount, i) => ({
          accountId: picked[i]?.id ?? "",
          side: "debit" as const,
          amount,
        })),
        ...credits.map((amount, i) => ({
          accountId: picked[debitCount + i]?.id ?? "",
          side: "credit" as const,
          amount,
        })),
      ]);
  });
}

/**
 * 科目・補助科目が重複せず、Σ期末（借方を正）= 0 の前年度の期末残高（computeBalances の形）。
 * 科目は accounts から選び、補助科目は sub-1 / sub-2 / なし（002 の carryForward、003 の繰越の検査で使う）
 */
export function balancedClosingArb(
  accounts: readonly Account[],
): fc.Arbitrary<CarryForwardBalance[]> {
  return fc
    .uniqueArray(
      fc.record({
        accountId: fc.constantFrom(...accounts.map((a) => a.id)),
        subAccountId: fc.option(fc.constantFrom("sub-1", "sub-2"), { nil: null }),
        closing: fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      }),
      {
        minLength: 1,
        maxLength: 30,
        selector: (b) => `${b.accountId}\u0000${b.subAccountId ?? ""}`,
      },
    )
    .map((rows) => {
      const sum = rows.reduce((s, r) => s + r.closing, 0);
      return rows.map((r, i) => (i === 0 ? { ...r, closing: r.closing - sum } : r));
    });
}

export function makeFiscalPeriod(
  fiscalYear: number,
  overrides: Partial<FiscalPeriod> = {},
): FiscalPeriod {
  return {
    id: syntheticId("0000000f", fiscalYear),
    fiscalYear,
    startDate: `${fiscalYear}-01-01`,
    endDate: `${fiscalYear}-12-31`,
    status: "open",
    closedAt: null,
    ...overrides,
  };
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** 会計期間内の日付 */
export function dateInPeriodArb(period: FiscalPeriod): fc.Arbitrary<string> {
  const start = Date.parse(`${period.startDate}T00:00:00Z`);
  const end = Date.parse(`${period.endDate}T00:00:00Z`);
  const day = 86_400_000;
  return fc.integer({ min: 0, max: Math.round((end - start) / day) }).map((offset) => {
    const d = new Date(start + offset * day);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  });
}

export type JournalWithVoidFlag = { date: string; lines: LineDraft[]; voided: boolean };

/** 取消フラグ付きの仕訳の列 */
export function journalSequenceArb(
  accounts: readonly Account[],
  period: FiscalPeriod,
  options: { maxLength?: number } = {},
): fc.Arbitrary<JournalWithVoidFlag[]> {
  return fc.array(
    fc.record({
      date: dateInPeriodArb(period),
      lines: balancedLinesArb(accounts),
      voided: fc.boolean(),
    }),
    { maxLength: options.maxLength ?? 30 },
  );
}
