import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import {
  BalanceSheetResponse,
  CASH_AND_DEPOSIT_CODES,
  HomeSummary,
  ProfitAndLossResponse,
} from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
  TODAY,
} from "./invoicing-helpers.ts";

// 011 T008: GET /entities/:id/home（contracts/http-api.md §1）。今日は 2026-10-31（偽の時計）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-home-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

async function journal(debit: string, credit: string, amount: number, date: string, memo?: string) {
  const res = await ctx.e.journals.$post({
    param: ctx.param,
    json: {
      date,
      ...(memo === undefined ? {} : { memo }),
      lines: [
        { side: "debit", accountId: ctx.accountId(debit), amount },
        { side: "credit", accountId: ctx.accountId(credit), amount },
      ],
    },
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()).journal;
}

const home = async () => {
  const res = await ctx.e.home.$get({ param: ctx.param });
  expect(res.status).toBe(200);
  return HomeSummary.parse(await res.json());
};

const okValue = <T>(s: { status: "ok"; value: T } | { status: "error"; code: string }): T => {
  if (s.status !== "ok") throw new Error(`section error: ${s.code}`);
  return s.value;
};

describe("GET /entities/:id/home", () => {
  it("空の事業体: 件数は 0、仕訳なし、取込なし。今期の数字は 0", async () => {
    const s = await home();
    expect(okValue(s.tasks)).toMatchObject({
      unprocessedStatements: 0,
      unlinkedReceipts: 0,
      unpaidInvoices: 0,
      overdueInvoices: 0,
      blockedRecurring: 0,
    });
    expect(okValue(s.recentJournals)).toEqual([]);
    expect(okValue(s.lastStatementImportAt)).toBeNull();
    expect(okValue(s.figures)).toMatchObject({
      fiscalYear: 2026,
      from: "2026-01-01",
      to: "2026-12-31",
      sales: 0,
      expenses: 0,
      netIncome: 0,
      cashAndDeposits: 0,
      outstanding: 0,
    });
  });

  it("今期の数字は reports/profit-and-loss・balance-sheet の応答と一致する（INV-72）", async () => {
    await journal("普通預金", "売上高", 330_000, "2026-02-27");
    await journal("地代家賃", "現金", 80_000, "2026-01-25");
    await journal("普通預金", "売上高", 10_000, "2026-12-01"); // 今日より後
    const figures = okValue((await home()).figures);
    if (figures === null) throw new Error("figures");

    const plRes = await ctx.e.reports["profit-and-loss"].$get({
      param: ctx.param,
      query: { from: figures.from, to: figures.to },
    });
    const pl = ProfitAndLossResponse.parse(await plRes.json());
    const total = (section: string) =>
      pl.sections.find((s) => s.section === section)?.total.amount ?? 0;
    expect(figures.sales).toBe(total("PL_SALES"));
    expect(figures.expenses).toBe(total("PL_COGS") + total("PL_EXPENSE"));
    expect(figures.netIncome).toBe(pl.netIncome.amount);

    const bsRes = await ctx.e.reports["balance-sheet"].$get({
      param: ctx.param,
      query: { asOf: TODAY },
    });
    const bs = BalanceSheetResponse.parse(await bsRes.json());
    const cash = bs.sections
      .flatMap((s) => s.rows)
      .filter((r) => CASH_AND_DEPOSIT_CODES.includes(r.code))
      .reduce((sum, r) => sum + r.amount, 0);
    expect(figures.cashAndDeposits).toBe(cash);
    expect(figures).toMatchObject({ sales: 340_000, expenses: 80_000 });
    expect(cash).toBe(330_000 - 80_000);
  });

  it("最近の仕訳: 登録の新しい順（日付ではない）", async () => {
    await journal("普通預金", "売上高", 100, "2026-10-01", "先に登録");
    await journal("普通預金", "売上高", 200, "2026-01-01", "後に登録");
    const recent = okValue((await home()).recentJournals);
    expect(recent.map((j) => j.memo)).toEqual(["後に登録", "先に登録"]);
    expect(recent[0]).toMatchObject({ number: 2, date: "2026-01-01", amount: 200 });
  });

  it("1 項目の失敗（FR-009）: 取込の回の表が読めなくても、200 で、その項目だけ error。ほかは返る", async () => {
    await journal("普通預金", "売上高", 100, "2026-10-01");
    const db = openTenant(ctx.entityId);
    db.$client.pragma("foreign_keys = OFF");
    db.$client.exec("DROP TABLE statement_batches");
    const s = await home();
    expect(s.lastStatementImportAt).toEqual({ status: "error", code: "INTERNAL" });
    expect(s.recentJournals.status).toBe("ok");
    expect(s.figures.status).toBe("ok");
  });

  it("存在しない事業体は 404", async () => {
    const res = await ctx.e.home.$get({
      param: { entityId: "0191f5a0-0000-7000-8000-000000000000" },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("ENTITY_NOT_FOUND");
  });

  it("今日を含む会計期間がなければ figures は null（ほかの項目は返す）", async () => {
    const other = await createInvoicingTestContext("2031-06-01T03:00:00.000Z");
    const res = await other.e.home.$get({ param: other.param });
    const s = HomeSummary.parse(await okBody(res));
    expect(s.figures).toEqual({ status: "ok", value: null });
    expect(s.tasks.status).toBe("ok");
    expect(okValue(s.tasks).blueReturnWarnings).toBe(0);
  });
});
