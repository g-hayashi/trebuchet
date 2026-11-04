import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { proposeOpeningBalances } from "../../src/import/freee/opening.ts";
import { type PlannedJournal, planImport } from "../../src/import/freee/plan.ts";
import {
  groupFreeeJournals,
  parseFreeeLedger,
  readFreeeFile,
} from "../../src/import/freee/read.ts";
import { reconcile } from "../../src/import/freee/reconcile.ts";
import type { ImportRef } from "../../src/import/types.ts";
import { computeBalances } from "../../src/reports/balances.ts";
import type { PostedLine, SubAccount } from "../../src/types.ts";
import {
  type FreeeModel,
  freeeModelArb,
  toFreeeJournalCsv,
  toFreeeLedgerCsv,
} from "../freee-arbitraries.ts";
import { ACCOUNTS, accountId, PERIOD_2025, planInput, ref } from "./import-setup.ts";

const runs = { numRuns: 40 };

/** カードの補助科目（取込で作られた状態） */
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

function postedLines(planned: readonly PlannedJournal[]): PostedLine[] {
  return planned.flatMap((p, i) =>
    p.valid.lines.map(
      (l, k): PostedLine => ({
        journalId: `journal-${p.freee.freeeJournalId}`,
        journalNo: i + 1,
        date: p.valid.date,
        memo: p.valid.memo,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        lineNo: k + 1,
        side: l.side,
        accountId: l.accountId,
        accountName: "",
        subAccountId: l.subAccountId,
        subAccountName: null,
        amount: l.amount,
        taxCategory: l.taxCategory,
        taxAmount: l.taxAmount,
        partnerId: l.partnerId,
        partnerName: null,
        description: l.description,
      }),
    ),
  );
}

/** モデルの仕訳帳と元帳を取り込んだ帳簿（computeBalances の材料）と参照 */
function imported(model: FreeeModel) {
  const subAccounts = cardSubAccounts(model);
  const journalFile = readFreeeFile(toFreeeJournalCsv(model));
  if (!journalFile.ok) throw new Error(JSON.stringify(journalFile.error));
  const plan = planImport(planInput(groupFreeeJournals(journalFile.value), { subAccounts }));
  expect(plan.preview.counts).toMatchObject({ new: model.journals.length, excluded: 1 });

  const ledgerFile = readFreeeFile(toFreeeLedgerCsv(model));
  if (!ledgerFile.ok) throw new Error(JSON.stringify(ledgerFile.error));
  const ledger = parseFreeeLedger(ledgerFile.value);
  if (!ledger.ok) throw new Error(JSON.stringify(ledger.error));
  const opening = proposeOpeningBalances({
    fiscalYear: model.fiscalYear,
    ledger: ledger.value,
    savedMappings: [],
    accounts: ACCOUNTS,
    subAccounts,
    periods: [PERIOD_2025],
    registered: [],
  });
  if (!opening.ok) throw new Error(JSON.stringify(opening.error));

  const refs: ImportRef[] = plan.planned.map((p) =>
    ref(p.freee.freeeJournalId, {
      freeeJournalNo: p.freee.freeeJournalNo,
      freeeDate: p.freee.date,
    }),
  );
  return {
    planned: plan.planned,
    ledger: ledger.value,
    opening: opening.value.rows,
    refs,
    subAccounts,
  };
}

function reconcileWith(
  model: FreeeModel,
  setup: ReturnType<typeof imported>,
  planned: readonly PlannedJournal[],
  refs: readonly ImportRef[],
) {
  const balances = computeBalances({
    opening: setup.opening,
    lines: postedLines(planned),
    periodStart: PERIOD_2025.startDate,
    to: PERIOD_2025.endDate,
  });
  const r = reconcile({
    fiscalYear: model.fiscalYear,
    ledger: setup.ledger,
    savedMappings: [],
    accounts: ACCOUNTS,
    subAccounts: setup.subAccounts,
    periods: [PERIOD_2025],
    balances,
    refs,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const modelArb = freeeModelArb({ maxJournals: 8 });

describe("reconcile のプロパティ（T046, INV-14）", () => {
  it("仕訳と期首残高を取り込んだ帳簿と元帳を照合すると、全行が一致する", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const setup = imported(model);
        const result = reconcileWith(model, setup, setup.planned, setup.refs);
        expect(result.unmapped).toEqual([]);
        expect(result.rows.filter((r) => !r.matched)).toEqual([]);
        expect(result.allMatched).toBe(true);
      }),
      runs,
    );
  });

  it("任意の1仕訳を帳簿から除くと、その仕訳の科目の行だけが不一致になり、差額がその仕訳の金額と一致する", () => {
    const scenarioArb = modelArb
      .filter((m) => m.journals.length > 0)
      .chain((model) =>
        fc.record({
          model: fc.constant(model),
          index: fc.nat({ max: model.journals.length - 1 }),
          voided: fc.boolean(),
        }),
      );
    fc.assert(
      fc.property(scenarioArb, ({ model, index, voided }) => {
        const setup = imported(model);
        const removed = setup.planned[index];
        if (removed === undefined) throw new Error("index");
        const removedId = removed.freee.freeeJournalId;
        const planned = setup.planned.filter((p) => p !== removed);
        // 取り消した取込なら参照は取消済みで残り、取り込まなかったなら参照がない
        const refs = voided
          ? setup.refs.map((r) =>
              r.freeeJournalId === removedId ? { ...r, revokedAt: "2026-10-19T00:00:00.000Z" } : r,
            )
          : setup.refs.filter((r) => r.freeeJournalId !== removedId);
        const result = reconcileWith(model, setup, planned, refs);

        const movement = new Map<string, { debit: number; credit: number }>();
        for (const l of removed.valid.lines) {
          const m = movement.get(l.accountId) ?? { debit: 0, credit: 0 };
          m[l.side] += l.amount;
          movement.set(l.accountId, m);
        }
        expect(new Set(result.rows.filter((r) => !r.matched).map((r) => r.accountId))).toEqual(
          new Set(movement.keys()),
        );
        expect(result.allMatched).toBe(false);
        for (const [id, m] of movement) {
          const row = result.rows.find((r) => r.accountId === id);
          expect(row?.difference.opening).toBe(0);
          expect(row?.difference.debit).toBe(-m.debit + 0);
          expect(row?.difference.credit).toBe(-m.credit + 0);
          const candidates = row?.candidates ?? [];
          expect(candidates.length).toBeGreaterThan(0);
          for (const c of candidates) {
            expect(c.freeeJournalNo).toBe(removed.freee.freeeJournalNo);
            expect(c.cause).toBe(voided ? "VOIDED_IMPORT" : "NOT_IMPORTED");
          }
          const sum = (side: "debit" | "credit") => candidates.reduce((s, c) => s + c[side], 0);
          expect({ debit: sum("debit"), credit: sum("credit") }).toEqual(m);
        }
      }),
      runs,
    );
  });
});
