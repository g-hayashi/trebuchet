import { describe, expect, it } from "vitest";
import type { NewJournal } from "../src/ports.ts";
import { domainError, err, ok, type StatementAuditEntry } from "../src/types.ts";
import { FakeSuggestionProvider, fakeStatementUnitOfWork } from "./fakes.ts";

const AT = "2026-10-25T00:00:00.000Z";

const journal = (id: string, journalNo: number): NewJournal => ({
  id,
  journalNo,
  date: "2026-10-31",
  fiscalPeriodId: "period-2026",
  memo: null,
  correctsJournalId: null,
  source: "statement",
  createdAt: AT,
  lines: [
    {
      id: `${id}-1`,
      lineNo: 1,
      side: "debit",
      accountId: "a",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: `${id}-2`,
      lineNo: 2,
      side: "credit",
      accountId: "b",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
});

const audit = (id: string): StatementAuditEntry => ({
  id,
  occurredAt: AT,
  targetType: "statement",
  targetId: "st-1",
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
});

describe("fakeStatementUnitOfWork", () => {
  it("途中の例外で仕訳・マスタ・記録がすべて残らない", () => {
    const uow = fakeStatementUnitOfWork();
    expect(() =>
      uow.run(({ ledger, masters, statements }) => {
        masters.insertTag({ id: "tag-1", name: "出張" });
        ledger.insertJournal(journal("j-1", 1));
        statements.appendStatementAudit(audit("audit-1"));
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.masters.listTags()).toEqual([]);
    expect(uow.statements.audits).toEqual([]);
  });

  it("err を返すと全部が巻き戻り、同じ err を返す。ok なら残る", () => {
    const uow = fakeStatementUnitOfWork();
    const failure = domainError("VALIDATION", "中止");
    const r = uow.run(({ ledger, statements }) => {
      ledger.insertJournal(journal("j-1", 1));
      statements.appendStatementAudit(audit("audit-1"));
      return err(failure);
    });
    expect(r).toEqual(err(failure));
    expect(uow.ledger.journals).toEqual([]);
    expect(uow.statements.audits).toEqual([]);

    uow.run(({ ledger, statements }) => {
      ledger.insertJournal(journal("j-2", 1));
      statements.appendStatementAudit(audit("audit-2"));
      return ok(null);
    });
    expect(uow.ledger.journals).toHaveLength(1);
    expect(uow.statements.audits.map((a) => a.id)).toEqual(["audit-2"]);
  });

  it("入れ子の run は例外", () => {
    const uow = fakeStatementUnitOfWork();
    expect(() => uow.run(() => uow.run(() => ok(null)))).toThrow();
  });
});

describe("FakeSuggestionProvider", () => {
  it("available と suggest の応答を差し替えられ、呼び出しを記録する", async () => {
    const provider = new FakeSuggestionProvider({ available: true });
    expect(await provider.available()).toBe(true);
    provider.respondWith(ok({ accountCode: "6200" }));
    const r = await provider.suggest({ amount: -500 }, { accounts: [] });
    expect(r).toEqual(ok({ accountCode: "6200" }));
    expect(provider.calls).toEqual([{ payload: { amount: -500 }, context: { accounts: [] } }]);
  });

  it("既定は使えない（available が false、suggest は失敗）", async () => {
    const provider = new FakeSuggestionProvider();
    expect(await provider.available()).toBe(false);
    const r = await provider.suggest({}, {});
    expect(r.ok).toBe(false);
  });
});
