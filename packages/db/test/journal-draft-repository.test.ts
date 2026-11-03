import { randomUUIDv7 } from "node:crypto";
import {
  createJournal,
  deleteJournalDraft,
  getHomeSummary,
  getJournalBook,
  getJournalDraft,
  getTrialBalance,
  replaceJournalDraft,
} from "@trebuchet/domain";
import { balancedLinesArb, dateInPeriodArb, fc, journalDraftArb } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createInvoicingUnitOfWork,
  createReceiptUnitOfWork,
  createRecurringUnitOfWork,
  createStatementUnitOfWork,
  DrizzleClosingStore,
} from "../src/index.ts";
import { DrizzleJournalDraftStore } from "../src/journal-draft-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant } from "../src/tenant-store.ts";
import { createTestEntity, NOW, type TempDataDir, TODAY, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("draft-repo");
});
afterEach(() => tmp.cleanup());
const clock = { now: () => NOW };
const draft = {
  mode: "detailed" as const,
  date: "2026-",
  memo: "未完成",
  partnerId: null,
  tagIds: [],
  lines: [
    {
      side: "debit" as const,
      accountId: null,
      subAccountId: null,
      amount: -1,
      taxCategory: "未入力",
      partnerId: "取引先入力中",
      tagIds: ["タグ入力中"],
      description: "行の説明",
    },
  ],
};

it("単一行の全置換・再取得・削除、他entityの隔離、STRICTとid制約", () => {
  const db = openTenant(createTestEntity().id);
  const deps = { store: new DrizzleJournalDraftStore(db), clock };
  expect(getJournalDraft(deps)).toMatchObject({ value: { draft: null, updatedAt: null } });
  replaceJournalDraft(deps, draft);
  expect(getJournalDraft(deps)).toMatchObject({ value: { draft, updatedAt: NOW } });
  const other = { store: new DrizzleJournalDraftStore(openTenant(createTestEntity().id)), clock };
  expect(getJournalDraft(other)).toMatchObject({ value: { draft: null } });
  replaceJournalDraft(deps, { ...draft, lines: [], memo: "置換" });
  expect(db.$client.prepare("SELECT * FROM journal_drafts").all()).toHaveLength(1);
  expect(
    db.$client.prepare("SELECT sql FROM sqlite_schema WHERE name='journal_drafts'").get(),
  ).toMatchObject({ sql: expect.stringMatching(/\)\s*STRICT$/) });
  expect(() =>
    db.$client.prepare("INSERT INTO journal_drafts VALUES (2, '{}', 'now')").run(),
  ).toThrow();
  deleteJournalDraft(deps);
  deleteJournalDraft(deps);
  expect(getJournalDraft(deps)).toMatchObject({ value: { draft: null, updatedAt: null } });
});

it("INV-69 任意の仕訳と下書き操作列で仕訳・監査・帳票・ホームの数字は不変（DB）", () => {
  const db = openTenant(createTestEntity().id);
  const masters = new DrizzleMasterRepository(db);
  const ledger = new DrizzleLedgerRepository(db);
  const period = masters.listFiscalPeriods()[0];
  if (!period) throw new Error("period");
  const journal = fc.record({
    date: dateInPeriodArb(period),
    lines: balancedLinesArb(masters.listAccounts().filter((a) => a.isActive)),
  });
  const deps = { store: new DrizzleJournalDraftStore(db), clock };
  const home = {
    ledger,
    blueReturn: { masters, reports: ledger, closing: new DrizzleClosingStore(db) },
    statements: { uow: createStatementUnitOfWork(db) },
    receipts: { uow: createReceiptUnitOfWork(db) },
    invoicing: { uow: createInvoicingUnitOfWork(db) },
    recurring: { uow: createRecurringUnitOfWork(db) },
  };
  const snapshot = () => ({
    tables: ["journals", "journal_lines", "audit_log"].map((name) =>
      db.$client.prepare(`SELECT * FROM ${name}`).all(),
    ),
    trial: getTrialBalance(home.blueReturn, { from: period.startDate, to: period.endDate }),
    book: getJournalBook(home.blueReturn, { from: period.startDate, to: period.endDate }),
    figures: getHomeSummary(home, TODAY).figures,
  });
  fc.assert(
    fc.property(
      fc.array(journal, { maxLength: 5 }),
      fc.array(fc.option(journalDraftArb, { nil: null }), { maxLength: 10 }),
      (journals, ops) => {
        for (const j of journals)
          expect(
            createJournal({ ledger, masters, clock, ids: { next: () => randomUUIDv7() } }, j).ok,
          ).toBe(true);
        const before = snapshot();
        if (before.figures.status !== "ok" || before.figures.value === null)
          throw new Error("figures");
        expect(before.trial.ok).toBe(true);
        expect(before.book.ok).toBe(true);
        for (const draft of ops) {
          if (draft === null) deleteJournalDraft(deps);
          else replaceJournalDraft(deps, draft);
          getJournalDraft(deps);
          expect(snapshot()).toEqual(before);
        }
      },
    ),
    { numRuns: 20 },
  );
});
