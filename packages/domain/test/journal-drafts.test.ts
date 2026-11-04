import fc from "fast-check";
import { expect, it } from "vitest";
import { createJournal } from "../src/usecases/create-journal.ts";
import { getHomeSummary } from "../src/usecases/home.ts";
import {
  deleteJournalDraft,
  getJournalDraft,
  replaceJournalDraft,
} from "../src/usecases/journal-drafts.ts";
import { getJournalBook, getTrialBalance } from "../src/usecases/reports.ts";
import { balancedLinesArb, dateInPeriodArb, journalDraftArb } from "./arbitraries.ts";
import { InMemoryJournalDraftStore } from "./fakes/journal-draft-store.ts";
import { setupHome } from "./home-setup.ts";
import { TODAY } from "./test-dates.ts";

it("取得・全置換・削除は独立し、返した値の変更は保存値を変えない", () => {
  const deps = { store: new InMemoryJournalDraftStore(), clock: setupHome().clock };
  expect(getJournalDraft(deps).value).toEqual({ draft: null, updatedAt: null });
  const draft = {
    mode: "quick" as const,
    date: null,
    memo: "未完成",
    partnerId: null,
    tagIds: [],
    lines: [],
  };
  expect(replaceJournalDraft(deps, draft).ok).toBe(true);
  const got = getJournalDraft(deps);
  if (!got.ok || !got.value.draft) throw new Error("draft");
  got.value.draft.memo = "変更";
  expect(getJournalDraft(deps).value?.draft?.memo).toBe("未完成");
  deleteJournalDraft(deps);
  deleteJournalDraft(deps);
  expect(getJournalDraft(deps).value).toEqual({ draft: null, updatedAt: null });
});

it("INV-69 任意の仕訳集合と下書きの操作列で帳簿・監査・帳票・ホームの数字は不変（fake）", () => {
  const template = setupHome();
  const period = template.masters.getFiscalPeriodByYear(2026);
  if (!period) throw new Error("period");
  const journal = fc.record({
    date: dateInPeriodArb(period),
    lines: balancedLinesArb(template.masters.listAccounts().filter((a) => a.isActive)),
  });
  fc.assert(
    fc.property(
      fc.array(journal, { maxLength: 10 }),
      fc.array(fc.option(journalDraftArb, { nil: null }), { maxLength: 20 }),
      (journals, ops) => {
        const t = setupHome();
        for (const j of journals) expect(createJournal(t.ledgerDeps, j).ok).toBe(true);
        const deps = { store: new InMemoryJournalDraftStore(), clock: t.clock };
        const snapshot = () =>
          structuredClone({
            ledger: t.ledger.state,
            trial: getTrialBalance(t.deps.blueReturn, {
              from: period.startDate,
              to: period.endDate,
            }),
            book: getJournalBook(t.deps.blueReturn, { from: period.startDate, to: period.endDate }),
            figures: getHomeSummary(t.deps, TODAY).figures,
          });
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
    { numRuns: 35 },
  );
});
