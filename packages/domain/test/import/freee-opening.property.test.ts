import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { proposeOpeningBalances } from "../../src/import/freee/opening.ts";
import { parseFreeeLedger, readFreeeFile } from "../../src/import/freee/read.ts";
import type { SubAccount } from "../../src/types.ts";
import {
  bookOpeningBalances,
  type FreeeModel,
  freeeModelArb,
  toFreeeLedgerCsv,
} from "../freee-arbitraries.ts";
import { ACCOUNTS, accountId, PERIOD_2025 } from "./import-setup.ts";

const byCode = new Map(ACCOUNTS.map((a) => [a.code, a]));

/** カードの補助科目（US1 の取込で作られた状態） */
function cardSubAccounts(model: FreeeModel): SubAccount[] {
  return model.accounts.flatMap((a) =>
    a.book?.subAccountName === undefined
      ? []
      : [
          {
            id: `sub-${a.book.subAccountName}`,
            accountId: accountId(a.book.code),
            name: a.book.subAccountName,
            isActive: true,
          },
        ],
  );
}

function proposalOf(
  model: FreeeModel,
  priorBalances?: Parameters<typeof proposeOpeningBalances>[0]["priorBalances"],
) {
  const file = readFreeeFile(toFreeeLedgerCsv(model));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  const ledger = parseFreeeLedger(file.value);
  if (!ledger.ok) throw new Error(JSON.stringify(ledger.error));
  const r = proposeOpeningBalances({
    fiscalYear: model.fiscalYear,
    ledger: ledger.value,
    savedMappings: [],
    accounts: ACCOUNTS,
    subAccounts: cardSubAccounts(model),
    periods: [PERIOD_2025],
    registered: [],
    priorBalances,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const modelArb = freeeModelArb({ maxJournals: 8 });

describe("proposeOpeningBalances のプロパティ（T037, INV-16）", () => {
  it("arbitraries の元帳から作った案は貸借が一致し、振替後の期首（帳簿の科目・補助科目ごと）と一致する", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const p = proposalOf(model);
        expect(p.unmapped).toEqual([]);
        expect(p.totals.debit).toBe(p.totals.credit);

        const expected = bookOpeningBalances(model)
          .filter((b) => b.balance !== 0)
          .map((b) => {
            const account = byCode.get(b.code);
            if (account === undefined) throw new Error(b.code);
            const positive = b.balance > 0;
            const opposite = account.normalSide === "debit" ? "credit" : "debit";
            return {
              accountId: account.id,
              subAccountId: b.subAccountName === undefined ? null : `sub-${b.subAccountName}`,
              side: positive ? account.normalSide : opposite,
              amount: Math.abs(b.balance),
            };
          });
        const actual = p.rows.map(({ accountId, subAccountId, side, amount }) => ({
          accountId,
          subAccountId,
          side,
          amount,
        }));
        const sortKey = (r: { accountId: string; subAccountId: string | null }) =>
          `${r.accountId}\u0000${r.subAccountId ?? ""}`;
        const sorted = <T extends { accountId: string; subAccountId: string | null }>(rows: T[]) =>
          [...rows].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        expect(sorted(actual)).toEqual(sorted(expected));

        // マイナスの行の数だけ NEGATIVE_OPENING
        const negatives = bookOpeningBalances(model).filter((b) => b.balance < 0).length;
        expect(p.warnings.filter((w) => w.code === "NEGATIVE_OPENING")).toHaveLength(negatives);
      }),
    );
  });

  it("前年度の期末が案と同じ繰越になるなら FR-020a の警告は出ず、1科目だけずらすとその科目と元入金に出る", () => {
    fc.assert(
      fc.property(modelArb, fc.integer({ min: 1, max: 1_000 }), (model, shift) => {
        const base = proposalOf(model);
        // 案の行を前年度の期末（借方を正）とみなす。損益・事業主勘定がないので carryForward は案そのもの
        const prior = base.rows.map((r) => ({
          accountId: r.accountId,
          subAccountId: r.subAccountId,
          closing: r.side === "debit" ? r.amount : -r.amount,
        }));
        const same = proposalOf(model, prior);
        expect(
          same.warnings.filter((w) => w.code === "OPENING_DIFFERS_FROM_CARRY_FORWARD"),
        ).toEqual([]);
        for (const c of same.comparisons) expect(c.carryForward).toBe(c.proposed);

        // 口座（1020）を shift 多く、売上（損益）を shift 多くした前年度
        const shifted = [
          ...prior,
          { accountId: accountId("1020"), subAccountId: null, closing: shift },
          { accountId: accountId("4010"), subAccountId: null, closing: -shift },
        ];
        const diff = proposalOf(model, shifted);
        const warned = diff.warnings
          .filter((w) => w.code === "OPENING_DIFFERS_FROM_CARRY_FORWARD")
          .map((w) => w.details?.accountId);
        expect(warned).toEqual([accountId("1020"), accountId("3020")]);
      }),
    );
  });
});
