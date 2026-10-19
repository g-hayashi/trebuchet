import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import type { JournalDraft, LineDraft } from "../src/types.ts";
import { createEntity } from "../src/usecases/create-entity.ts";
import { createJournal, type JournalDeps } from "../src/usecases/create-journal.ts";
import {
  FixedClock,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";

let masters: InMemoryMasterRepository;
let ledger: InMemoryLedgerRepository;
let deps: JournalDeps;

beforeEach(() => {
  masters = new InMemoryMasterRepository();
  ledger = new InMemoryLedgerRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock("2026-10-31T09:00:00.000Z");
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => masters, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  deps = { ledger, masters, ids, clock };
});

const accountId = (name: string) => {
  const a = masters.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a.id;
};

const line = (side: LineDraft["side"], name: string, amount: number): LineDraft => ({
  side,
  accountId: accountId(name),
  amount,
});

const sale = (amount = 495_000, date = "2026-10-31"): JournalDraft => ({
  date,
  memo: "10月分",
  lines: [line("debit", "売掛金", amount), line("credit", "売上高", amount)],
});

describe("createJournal（US2）", () => {
  it("INV-8: 仕訳番号は 1 から登録順に増える", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 20 }),
        (amounts) => {
          const repo = new InMemoryLedgerRepository();
          const numbers = amounts.map((amount, i) => {
            const r = createJournal({ ...deps, ledger: repo }, sale(amount + i));
            if (!r.ok) throw new Error(r.error.message);
            return r.value.journal.journalNo;
          });
          expect(numbers).toEqual(amounts.map((_, i) => i + 1));
        },
      ),
      { numRuns: 30 },
    );
  });

  it("登録した仕訳は有効・version 1 で、audit_log に create が1件、変更後の内容つきで残る", () => {
    const r = createJournal(deps, sale());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { journal, warnings } = r.value;
    expect(warnings).toEqual([]);
    expect(journal).toMatchObject({
      journalNo: 1,
      date: "2026-10-31",
      memo: "10月分",
      status: "active",
      version: 1,
      source: "manual",
      correctsJournalId: null,
      createdAt: "2026-10-31T09:00:00.000Z",
      updatedAt: "2026-10-31T09:00:00.000Z",
    });
    expect(journal.lines).toHaveLength(2);
    expect(new Set(journal.lines.map((l) => l.id)).size).toBe(2);
    expect(ledger.getJournal(journal.id)).toEqual(journal);

    expect(ledger.audits).toHaveLength(1);
    expect(ledger.audits[0]).toMatchObject({
      targetType: "journal",
      targetId: journal.id,
      action: "create",
      reason: null,
      beforeJson: null,
      occurredAt: "2026-10-31T09:00:00.000Z",
    });
    expect(JSON.parse(ledger.audits[0]?.afterJson ?? "null")).toEqual(journal);
  });

  it("FR-018: 直前の仕訳と日付・科目・金額の組が同じなら POSSIBLE_DUPLICATE を返すが、登録はされる", () => {
    const first = createJournal(deps, sale());
    const second = createJournal(deps, { ...sale(), memo: "別のメモ" });
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) return;
    expect(second.value.warnings).toEqual([
      expect.objectContaining({
        code: "POSSIBLE_DUPLICATE",
        details: { journalId: first.value.journal.id, journalNo: 1 },
      }),
    ]);
    expect(second.value.journal.journalNo).toBe(2);
    expect(ledger.journals).toHaveLength(2);
  });

  it("行の順が違っても組が同じなら重複の候補。日付・金額・科目のどれかが違えば警告しない", () => {
    createJournal(deps, sale());
    const reordered = createJournal(deps, { ...sale(), lines: [...sale().lines].reverse() });
    expect(reordered.ok && reordered.value.warnings.map((w) => w.code)).toEqual([
      "POSSIBLE_DUPLICATE",
    ]);
    for (const draft of [
      sale(495_000, "2026-11-01"),
      sale(495_001, "2026-11-01"),
      {
        date: "2026-11-01",
        lines: [line("debit", "普通預金", 495_001), line("credit", "売上高", 495_001)],
      },
    ]) {
      const r = createJournal(deps, draft);
      expect(r.ok && r.value.warnings).toEqual([]);
    }
  });

  it("検証エラーのときは何も書き込まず、すべての違反を details.errors に入れる", () => {
    const r = createJournal(deps, {
      date: "2027-01-05",
      lines: [line("debit", "売掛金", 500_000), line("credit", "売上高", 495_000)],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("OUT_OF_PERIOD");
    expect(r.error.details).toMatchObject({
      date: "2027-01-05",
      suggest: "create_fiscal_period",
      errors: [
        expect.objectContaining({ code: "OUT_OF_PERIOD" }),
        expect.objectContaining({
          code: "UNBALANCED",
          details: { debit: 500_000, credit: 495_000, diff: 5000 },
        }),
      ],
    });
    expect(ledger.journals).toEqual([]);
    expect(ledger.audits).toEqual([]);
    expect(ledger.nextJournalNo()).toBe(1);
  });

  it("貸借の不一致だけなら UNBALANCED で details に差額が入る", () => {
    const r = createJournal(deps, {
      date: "2026-10-31",
      lines: [line("debit", "売掛金", 500_000), line("credit", "売上高", 495_000)],
    });
    expect(!r.ok && r.error).toMatchObject({
      code: "UNBALANCED",
      details: { debit: 500_000, credit: 495_000, diff: 5000 },
    });
  });

  it("存在しない仕訳を訂正元に指定すると拒否する", () => {
    const r = createJournal(deps, {
      ...sale(),
      correctsJournalId: "0000000e-0000-7000-8000-000000000001",
    });
    expect(!r.ok && r.error).toMatchObject({
      code: "VALIDATION",
      details: { field: "correctsJournalId" },
    });
    expect(ledger.journals).toEqual([]);
  });

  it("書き込みの途中で例外が起きたら、仕訳も audit_log も残らない", () => {
    ledger.failOnAppendAudit = true;
    expect(() => createJournal(deps, sale())).toThrow();
    expect(ledger.journals).toEqual([]);
    expect(ledger.audits).toEqual([]);
  });
});
