import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeHomeUse,
  type HomeUseAssessment,
  proposeHomeUseAdjustment,
} from "../../src/blue-return/home-use.ts";
import { type JournalContext, validateJournal } from "../../src/journal.ts";
import type {
  AdjustmentRef,
  HomeUseAllocation,
  JournalDraft,
  PostedLine,
} from "../../src/types.ts";
import { amountArb } from "../arbitraries.ts";
import {
  accountIdOf,
  homeUseArb,
  type YearLedger,
  yearLedgerArb,
} from "../blue-return-arbitraries.ts";

const CASH = accountIdOf("1010");

const contextOf = (ledger: YearLedger): JournalContext => ({
  accounts: ledger.accounts,
  subAccounts: [],
  partners: ledger.partners,
  tags: [],
  periods: [ledger.period],
  taxSettings: [
    { effectiveFrom: "2019-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
  ],
  taxRates: [],
});

/** 案の仕訳を登録したものとして、帳票の行にする */
const post = (draft: JournalDraft, journalId: string, journalNo: number): PostedLine[] =>
  draft.lines.map((l, i) => ({
    journalId,
    journalNo,
    date: draft.date,
    memo: draft.memo ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    lineNo: i + 1,
    side: l.side,
    accountId: l.accountId,
    accountName: "",
    subAccountId: l.subAccountId ?? null,
    subAccountName: null,
    amount: l.amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    partnerName: null,
    description: null,
  }));

/** 対象の科目と現金の仕訳（費用の追加・戻り） */
const extraJournal = (
  accountId: string,
  side: "debit" | "credit",
  amount: number,
  journalId: string,
  journalNo: number,
): PostedLine[] =>
  post(
    {
      date: "2025-07-01",
      lines: [
        { side, accountId, amount },
        { side: side === "debit" ? "credit" : "debit", accountId: CASH, amount },
      ],
    },
    journalId,
    journalNo,
  );

const assess = (
  ledger: YearLedger,
  allocation: HomeUseAllocation,
  lines: readonly PostedLine[],
  refs: readonly AdjustmentRef[],
): HomeUseAssessment => {
  const r = proposeHomeUseAdjustment({
    allocation,
    allocations: [allocation],
    accounts: ledger.accounts,
    period: ledger.period,
    lines,
    refs,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const sum = (lines: readonly { side: string; amount: number }[], side: string) =>
  lines.filter((l) => l.side === side).reduce((s, l) => s + l.amount, 0);

describe("computeHomeUse の性質（INV-20）", () => {
  it("0 ≤ 事業分 ≤ 金額、事業分 + 家事分 = 金額、事業分 = ⌊金額 × 割合 / 10000⌋（安全な整数の全域）", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 1, max: 1_000_000_000 }),
          fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        ),
        fc.oneof(fc.constantFrom(0, 1, 9999, 10000), fc.integer({ min: 0, max: 10000 })),
        (book, ratio) => {
          const { business, home } = computeHomeUse(book, ratio);
          expect(Number.isSafeInteger(business) && Number.isSafeInteger(home)).toBe(true);
          expect(business).toBeGreaterThanOrEqual(0);
          expect(business).toBeLessThanOrEqual(book);
          expect(business + home).toBe(book);
          expect(BigInt(business)).toBe((BigInt(book) * BigInt(ratio)) / 10000n);
          if (ratio === 10000) expect(home).toBe(0);
          if (ratio === 0) expect(business).toBe(0);
        },
      ),
    );
  });
});

describe("proposeHomeUseAdjustment の性質（INV-20・INV-23、SC-004）", () => {
  it("INV-23: 案は validateJournal を通り、貸借一致・行の金額 > 0・年度末日付。金額は差額の絶対値", () => {
    fc.assert(
      fc.property(yearLedgerArb, homeUseArb, (ledger, allocation) => {
        const a = assess(ledger, allocation, ledger.lines, []);
        if (a.bookAmount > 0) {
          expect(a.business + a.home).toBe(a.bookAmount);
          expect(a.business).toBeGreaterThanOrEqual(0);
          expect(a.business).toBeLessThanOrEqual(a.bookAmount);
        }
        expect(a.difference).toBe(a.home - a.registered);
        if (a.proposal === null) {
          expect(a.difference).toBe(0);
          expect(a.reason).not.toBeNull();
          return;
        }
        const { journal } = a.proposal;
        expect(validateJournal(journal, contextOf(ledger)).ok).toBe(true);
        expect(journal.date).toBe(ledger.period.endDate);
        expect(sum(journal.lines, "debit")).toBe(sum(journal.lines, "credit"));
        expect(sum(journal.lines, "debit")).toBe(Math.abs(a.difference));
        for (const l of journal.lines) expect(l.amount).toBeGreaterThan(0);
      }),
    );
  });

  it("振替を登録した後に案を作り直すと差額 0。帳簿の追加・戻りのたびに差額だけを振り替えても同じ", () => {
    const roundArb = fc.array(
      fc.tuple(fc.constantFrom<"debit" | "credit">("debit", "debit", "credit"), amountArb),
      { maxLength: 3 },
    );
    fc.assert(
      fc.property(
        yearLedgerArb,
        homeUseArb,
        fc.array(roundArb, { minLength: 1, maxLength: 4 }),
        (ledger, allocation, rounds) => {
          let lines: PostedLine[] = [...ledger.lines];
          const refs: AdjustmentRef[] = [];
          let no = 10_000;
          for (const round of rounds) {
            for (const [side, amount] of round) {
              no += 1;
              lines = [
                ...lines,
                ...extraJournal(allocation.accountId, side, amount, `x-${no}`, no),
              ];
            }
            const before = assess(ledger, allocation, lines, refs);
            if (before.proposal === null) {
              expect(before.difference).toBe(0);
              continue;
            }
            expect(validateJournal(before.proposal.journal, contextOf(ledger)).ok).toBe(true);
            no += 1;
            const journalId = `t-${no}`;
            lines = [...lines, ...post(before.proposal.journal, journalId, no)];
            refs.push({
              journalId,
              kind: "home_use",
              allocationId: allocation.id,
              assetId: null,
              deferredAssetId: null,
              fiscalYear: ledger.period.fiscalYear,
            });

            const after = assess(ledger, allocation, lines, refs);
            // 振替の行は帳簿の金額に入らない
            expect(after.bookAmount).toBe(before.bookAmount);
            expect(after.difference).toBe(0);
            expect(after.proposal).toBeNull();
            expect(after.registered).toBe(after.home);
            // 帳簿全体の貸借は一致したまま
            expect(sum(lines, "debit")).toBe(sum(lines, "credit"));
          }
        },
      ),
    );
  });
});
