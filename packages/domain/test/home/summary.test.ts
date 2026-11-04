import { CASH_AND_DEPOSIT_CODES } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { cashAndDeposits, countInvoiceTasks, recentJournalOf } from "../../src/home/summary.ts";
import { domainError, err } from "../../src/types.ts";
import { getBlueReturn } from "../../src/usecases/blue-return.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { getHomeSummary } from "../../src/usecases/home.ts";
import { createRecurring } from "../../src/usecases/recurring.ts";
import { excludeStatement } from "../../src/usecases/statement-approval.ts";
import { type HomeCtx, setupHome } from "../home-setup.ts";
import { invoiceRecord } from "../invoicing-setup.ts";
import { makeReceiptLinkRow, seedReceipt } from "../receipt-setup.ts";
import { TODAY } from "../test-dates.ts";

// 011 US1: ホームの要約（R3、data-model §2.1。FR-009）

const ok = <T>(section: { status: "ok"; value: T } | { status: "error"; code: string }): T => {
  if (section.status !== "ok") throw new Error(`section error: ${section.code}`);
  return section.value;
};

const sale = (t: HomeCtx, amount: number, date: string, memo = "売上") => {
  const r = createJournal(t.ledgerDeps, {
    date,
    memo,
    lines: [
      { side: "debit", accountId: t.accountId("普通預金"), amount },
      { side: "credit", accountId: t.accountId("売上高"), amount },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.journal;
};

describe("CASH_AND_DEPOSIT_CODES", () => {
  it("seed の現金と普通預金のコードに一致する", () => {
    const t = setupHome();
    const codes = ["現金", "普通預金"].map(
      (name) => t.masters.listAccounts().find((a) => a.name === name)?.code,
    );
    expect([...CASH_AND_DEPOSIT_CODES].sort()).toEqual([...codes].sort());
  });
});

describe("純関数", () => {
  it("countInvoiceTasks: 未入金は unpaid と partial、期限切れは overdue の件数。paid と voided は数えない", () => {
    const base = {
      partnerId: "p",
      invoiceNo: "n",
      issueDate: "2026-10-01",
      dueDate: "2026-10-31",
      recipientName: "x",
      total: 1,
      paid: 0,
      remaining: 1,
      overdue: false,
    };
    const rows = [
      { ...base, status: "unpaid", overdue: true },
      { ...base, status: "partial" },
      { ...base, status: "paid", remaining: 0 },
      { ...base, status: "voided", remaining: 0 },
    ] as never;
    expect(countInvoiceTasks(rows)).toEqual({ unpaidInvoices: 2, overdueInvoices: 1 });
  });

  it("cashAndDeposits: 貸借対照表の現金・普通預金の行だけを合計する", () => {
    const bs = {
      sections: [
        {
          section: "BS_ASSET",
          rows: [
            { code: "1010", amount: 100 },
            { code: "1020", amount: 250 },
            { code: "1100", amount: 999 },
          ],
        },
      ],
    } as never;
    expect(cashAndDeposits(bs)).toBe(350);
  });

  it("recentJournalOf: 金額は借方の合計、番号・日付・摘要・登録日時を写す", () => {
    const t = setupHome();
    const j = sale(t, 1234, "2026-10-01", "メモ");
    expect(recentJournalOf(j)).toEqual({
      id: j.id,
      number: j.journalNo,
      date: "2026-10-01",
      memo: "メモ",
      amount: 1234,
      createdAt: j.createdAt,
    });
  });
});

describe("getHomeSummary: 今日やること", () => {
  it("何もなければすべて 0、取込の日時は null、最近の仕訳は空", () => {
    const t = setupHome();
    const s = getHomeSummary(t.deps, TODAY);
    // 決算書の警告の件数は決算書そのもの（今期の年）と同じ。空の帳簿でも決算書の警告は出うる
    const warnings = getBlueReturn(t.deps.blueReturn, { fiscalYear: 2026 });
    expect(warnings.ok).toBe(true);
    expect(ok(s.tasks)).toEqual({
      unprocessedStatements: 0,
      unlinkedReceipts: 0,
      unpaidInvoices: 0,
      overdueInvoices: 0,
      blockedRecurring: 0,
      blueReturnWarnings: warnings.ok ? warnings.value.warnings.length : -1,
    });
    expect(ok(s.recentJournals)).toEqual([]);
    expect(ok(s.lastStatementImportAt)).toBeNull();
  });

  it("未処理の明細: 除外した明細は数えない。取込の日時は取込の回の createdAt", () => {
    const t = setupHome();
    t.mapBank();
    t.importRows([
      t.row({ content: "ショップ001" }),
      t.row({ content: "ショップ002" }),
      t.row({ content: "ショップ003" }),
    ]);
    expect(ok(getHomeSummary(t.deps, TODAY).tasks).unprocessedStatements).toBe(3);
    const r = excludeStatement(t.statementDeps, t.idOf("ショップ002"));
    expect(r.ok).toBe(true);
    const s = getHomeSummary(t.deps, TODAY);
    expect(ok(s.tasks).unprocessedStatements).toBe(2);
    const batches = t.uow.statements.state.batches;
    expect(ok(s.lastStatementImportAt)).toBe(
      [...batches]
        .map((b) => b.createdAt)
        .sort()
        .at(-1),
    );
  });

  it("仕訳のない証憑: 結びつきのあるもの・削除済みを数えない", () => {
    const t = setupHome();
    seedReceipt(t.receiptUow, { id: "r1" });
    seedReceipt(t.receiptUow, { id: "r2" });
    seedReceipt(t.receiptUow, {
      id: "r3",
      deletedAt: "2026-10-30T00:00:00.000Z",
      deletedReason: "x",
    });
    seedReceipt(t.receiptUow, { id: "r4" });
    const j = sale(t, 1000, "2026-10-01");
    t.receipts.insertLink(makeReceiptLinkRow({ id: "l4", receiptId: "r4", journalId: j.id }));
    expect(ok(getHomeSummary(t.deps, TODAY).tasks).unlinkedReceipts).toBe(2);
  });

  it("未入金の請求書と期限切れ（取消・全額入金は数えない）", () => {
    const t = setupHome();
    const p = t.addPartner();
    const add = (id: string, seq: number, over: Parameters<typeof invoiceRecord>[0]) =>
      t.invoicing.insertInvoice(
        invoiceRecord({
          id,
          invoiceNo: `X-${seq}`,
          seq,
          partnerId: p.id,
          journalId: `j-${id}`,
          ...over,
        }),
      );
    add("i1", 1, { dueDate: "2026-10-30", total: 100 }); // 期限切れ
    add("i2", 2, { dueDate: "2026-11-30", total: 200 }); // 期限内
    add("i3", 3, {
      dueDate: "2026-10-01",
      total: 300,
      voidedAt: "2026-10-02T00:00:00.000Z",
      voidReason: "x",
    });
    add("i4", 4, { dueDate: "2026-10-01", total: 400 }); // 全額入金
    t.invoicing.state.payments.push({
      id: "pay-4",
      invoiceId: "i4",
      receivedOn: "2026-10-02",
      amount: 400,
      feeAmount: 0,
      depositAccountId: t.accountId("普通預金"),
      depositSubAccountId: null,
      journalId: "j-pay-4",
      createdAt: "2026-10-02T00:00:00.000Z",
      voidedAt: null,
      voidReason: null,
      voidJournalId: null,
    } as never);
    const s = getHomeSummary(t.deps, TODAY);
    expect(ok(s.tasks)).toMatchObject({ unpaidInvoices: 2, overdueInvoices: 1 });
    expect(ok(s.figures)?.outstanding).toBe(300);
  });

  it("登録できなかった定期仕訳: 締め済みの年度の回を数える", () => {
    const t = setupHome();
    const created = createRecurring(
      { uow: t.recurringUow, ids: t.ids, clock: t.clock },
      {
        name: "家賃",
        dayOfMonth: 25,
        startMonth: "2026-10",
        lines: [
          { side: "debit", accountId: t.accountId("地代家賃"), amount: 80_000 },
          { side: "credit", accountId: t.accountId("普通預金"), amount: 80_000 },
        ],
        confirm: true,
      },
      TODAY,
    );
    expect(created.ok).toBe(true);
    expect(ok(getHomeSummary(t.deps, TODAY).tasks).blockedRecurring).toBe(0);
    t.closeYear(2026);
    expect(ok(getHomeSummary(t.deps, TODAY).tasks).blockedRecurring).toBe(1);
  });

  it("決算書の警告: 今日を含む会計期間がなければ 0（figures は null）", () => {
    const t = setupHome();
    const s = getHomeSummary(t.deps, "2030-01-15");
    expect(ok(s.tasks).blueReturnWarnings).toBe(0);
    expect(ok(s.figures)).toBeNull();
  });

  it("決算書の警告: 法人の事業体は 0（個人だけの機能。失敗にしない）", () => {
    const t = setupHome();
    const profile = t.masters.getProfile();
    if (profile === undefined) throw new Error("profile");
    t.masters.saveProfile({ ...profile, kind: "corporation" });
    expect(ok(getHomeSummary(t.deps, TODAY).tasks).blueReturnWarnings).toBe(0);
  });
});

describe("getHomeSummary: 今期の数字・最近の仕訳", () => {
  it("今期の数字: 売上・経費・利益・現金と預金・未回収。今日より後の仕訳は現金と預金に入らない", () => {
    const t = setupHome();
    sale(t, 100_000, "2026-03-01");
    sale(t, 50_000, "2026-12-01"); // 今日より後
    const rent = createJournal(t.ledgerDeps, {
      date: "2026-04-01",
      memo: "家賃",
      lines: [
        { side: "debit", accountId: t.accountId("地代家賃"), amount: 30_000 },
        { side: "credit", accountId: t.accountId("現金"), amount: 30_000 },
      ],
    });
    expect(rent.ok).toBe(true);
    const figures = ok(getHomeSummary(t.deps, TODAY).figures);
    expect(figures).toEqual({
      fiscalYear: 2026,
      from: "2026-01-01",
      to: "2026-12-31",
      sales: 150_000,
      expenses: 30_000,
      netIncome: 120_000,
      cashAndDeposits: 70_000,
      outstanding: 0,
    });
  });

  it("最近の仕訳: 取消を除き、登録日時の新しい順に 5 件", () => {
    const t = setupHome();
    const made = [1, 2, 3, 4, 5, 6, 7].map((n) => {
      t.clock.value = `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`;
      return sale(t, n * 100, "2026-01-05", `m${n}`);
    });
    // 7 件目（最新）を取り消す
    const last = made.at(-1);
    if (last === undefined) throw new Error("no journal");
    t.ledger.state.journals = t.ledger.state.journals.map((j) =>
      j.id === last.id ? { ...j, status: "voided" } : j,
    );
    const recent = ok(getHomeSummary(t.deps, TODAY).recentJournals);
    expect(recent.map((j) => j.memo)).toEqual(["m6", "m5", "m4", "m3", "m2"]);
    expect(recent[0]?.amount).toBe(600);
  });
});

describe("getHomeSummary: 項目ごとの失敗（FR-009）", () => {
  it("例外は INTERNAL、err はそのコードの error にし、ほかの項目は返す", () => {
    const t = setupHome();
    sale(t, 1000, "2026-03-01");
    const throwing = {
      run: () => {
        throw new Error("boom");
      },
    };
    const failing = { run: () => err(domainError("VALIDATION", "x")) };

    const a = getHomeSummary({ ...t.deps, statements: { uow: throwing as never } }, TODAY);
    expect(a.tasks).toEqual({ status: "error", code: "INTERNAL" });
    expect(a.figures.status).toBe("ok");
    expect(a.recentJournals.status).toBe("ok");

    const b = getHomeSummary({ ...t.deps, invoicing: { uow: failing as never } }, TODAY);
    expect(b.tasks).toEqual({ status: "error", code: "VALIDATION" });
    // 未回収は請求から作るので、今期の数字も同じ原因で error になる
    expect(b.figures).toEqual({ status: "error", code: "VALIDATION" });
    expect(b.recentJournals.status).toBe("ok");
    expect(b.lastStatementImportAt.status).toBe("ok");

    const c = getHomeSummary({ ...t.deps, statements: { uow: failing as never } }, TODAY);
    expect(c.tasks).toEqual({ status: "error", code: "VALIDATION" });
    expect(c.lastStatementImportAt).toEqual({ status: "error", code: "VALIDATION" });
    expect(c.figures.status).toBe("ok");
  });
});
