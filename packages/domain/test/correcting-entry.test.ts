import { beforeEach, describe, expect, it } from "vitest";
import { createJournal } from "../src/usecases/create-journal.ts";
import { getJournalDetail } from "../src/usecases/journal-queries.ts";
import { setupLedger } from "./ledger-fixture.ts";

let f: ReturnType<typeof setupLedger>;

beforeEach(() => {
  f = setupLedger();
});

describe("訂正仕訳（US3, FR-019a）", () => {
  it("締め済みの期間の仕訳を指す訂正仕訳を、締めていない期間の日付で起票できる", () => {
    const original = f.create(f.sale(495_000, "2025-12-20"));
    f.closeYear(2025);
    const r = createJournal(f.deps, {
      date: "2026-01-10",
      memo: "No.1 の金額の訂正",
      correctsJournalId: original.id,
      lines: [f.line("debit", "売掛金", 5000), f.line("credit", "売上高", 5000)],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.journal).toMatchObject({ correctsJournalId: original.id, date: "2026-01-10" });
    expect(f.ledger.getJournal(original.id)).toEqual(original);
  });

  it("締めていない期間の仕訳を指すと VALIDATION（field: correctsJournalId）", () => {
    const original = f.create(f.sale(495_000, "2026-01-05"));
    const r = createJournal(f.deps, { ...f.sale(5000), correctsJournalId: original.id });
    expect(!r.ok && r.error).toMatchObject({
      code: "VALIDATION",
      details: { field: "correctsJournalId" },
    });
    expect(f.ledger.journals).toHaveLength(1);
  });

  it("訂正仕訳の日付が締め済みの期間なら PERIOD_CLOSED", () => {
    const original = f.create(f.sale(495_000, "2025-12-20"));
    f.closeYear(2025);
    const r = createJournal(f.deps, {
      ...f.sale(5000, "2025-12-31"),
      correctsJournalId: original.id,
    });
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
  });

  it("元の仕訳から correctingJournalsOf で訂正仕訳をたどれ、訂正仕訳から元の仕訳をたどれる", () => {
    const original = f.create(f.sale(495_000, "2025-12-20"));
    f.create(f.sale(1000, "2026-01-01"));
    f.closeYear(2025);
    const first = f.create({ ...f.sale(5000, "2026-01-10"), correctsJournalId: original.id });
    const second = f.create({ ...f.sale(7000, "2026-02-10"), correctsJournalId: original.id });

    expect(f.ledger.correctingJournalsOf(original.id).map((j) => j.id)).toEqual([
      first.id,
      second.id,
    ]);

    const detail = getJournalDetail(f.deps, original.id);
    expect(detail.ok && detail.value).toMatchObject({
      journal: original,
      correctsJournal: null,
      correctingJournals: [
        { id: first.id, journalNo: first.journalNo, date: "2026-01-10", status: "active" },
        { id: second.id, journalNo: second.journalNo, date: "2026-02-10", status: "active" },
      ],
    });
    const back = getJournalDetail(f.deps, first.id);
    expect(back.ok && back.value).toMatchObject({
      correctsJournal: {
        id: original.id,
        journalNo: original.journalNo,
        date: "2025-12-20",
        status: "active",
      },
      correctingJournals: [],
    });
    const missing = getJournalDetail(f.deps, "0000000e-0000-7000-8000-000000000001");
    expect(!missing.ok && missing.error.code).toBe("JOURNAL_NOT_FOUND");
  });
});
