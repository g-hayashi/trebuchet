import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import {
  BalanceSheetResponse,
  GeneralLedgerResponse,
  JournalBookResponse,
  ProfitAndLossResponse,
  TrialBalanceResponse,
} from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookup, client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let acc: (name: string) => string;

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });
const r = () => e.reports;

beforeEach(async () => {
  tmp = useTempDataDir("server-reports");
  entityId = await createTestEntity();
  acc = await accountLookup(entityId);
});
afterEach(() => tmp.cleanup());

async function simple(debit: string, credit: string, amount: number, date: string) {
  const res = await e.journals.$post({
    param: param(),
    json: {
      date,
      lines: [
        { side: "debit", accountId: acc(debit), amount },
        { side: "credit", accountId: acc(credit), amount },
      ],
    },
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()).journal;
}

async function registerOpening(year = "2026") {
  const res = await e["fiscal-periods"][":year"]["opening-balances"].$put({
    param: { ...param(), year },
    json: [
      { accountId: acc("普通預金"), side: "debit", amount: 1_000_000 },
      { accountId: acc("元入金"), side: "credit", amount: 1_000_000 },
    ],
  });
  if (res.status !== 200) throw new Error(`opening failed: ${res.status}`);
}

const YEAR = { from: "2026-01-01", to: "2026-12-31" };

describe("GET /reports/*（US4, FR-026〜FR-033）", () => {
  beforeEach(async () => {
    await registerOpening();
    await simple("売掛金", "売上高", 330_000, "2026-01-31");
    await simple("普通預金", "売掛金", 330_000, "2026-02-27");
    await simple("地代家賃", "普通預金", 80_000, "2026-01-25");
    const voided = await simple("通信費", "普通預金", 8_800, "2026-03-01");
    const v = await e.journals[":journalId"].void.$post({
      param: { entityId, journalId: voided.id },
      json: { reason: "二重登録", version: 1 },
    });
    if (v.status !== 200) throw new Error(`void failed: ${v.status}`);
  });

  it("仕訳帳: 日付 → 仕訳番号の順で、取消済みを含まない", async () => {
    const res = await r()["journal-book"].$get({ param: param(), query: YEAR });
    expect(res.status).toBe(200);
    const body = JournalBookResponse.parse(await res.json());
    expect(body.entries.map((x) => [x.date, x.journalNo])).toEqual([
      ["2026-01-25", 3],
      ["2026-01-31", 1],
      ["2026-02-27", 2],
    ]);
    expect(body.totals).toEqual({ debit: 740_000, credit: 740_000 });
    expect(body.warnings).toEqual([]);
  });

  it("試算表: 期首残高を含み、貸借が一致する", async () => {
    const res = await r()["trial-balance"].$get({ param: param(), query: YEAR });
    expect(res.status).toBe(200);
    const body = TrialBalanceResponse.parse(await res.json());
    expect(body.rows.find((x) => x.name === "普通預金")).toMatchObject({
      opening: 1_000_000,
      debit: 330_000,
      credit: 80_000,
      closing: 1_250_000,
    });
    expect(body.totals).toEqual({
      debit: 740_000,
      credit: 740_000,
      closingDebit: 1_330_000,
      closingCredit: 1_330_000,
    });
    expect(body.balanced).toBe(true);
  });

  it("総勘定元帳: 前期繰越から日付順に残高を出す", async () => {
    const res = await r()["general-ledger"].$get({
      param: param(),
      query: { ...YEAR, accountId: acc("普通預金") },
    });
    expect(res.status).toBe(200);
    const body = GeneralLedgerResponse.parse(await res.json());
    expect(body.broughtForward).toBe(1_000_000);
    expect(body.entries.map((x) => [x.date, x.counterpart, x.balance])).toEqual([
      ["2026-01-25", "地代家賃", 920_000],
      ["2026-02-27", "売掛金", 1_250_000],
    ]);
    expect(body.closing).toBe(1_250_000);
  });

  it("損益計算書と貸借対照表: 当期利益が一致し、貸借が一致する", async () => {
    const pl = await r()["profit-and-loss"].$get({ param: param(), query: YEAR });
    expect(pl.status).toBe(200);
    const plBody = ProfitAndLossResponse.parse(await pl.json());
    expect(plBody.netIncome.amount).toBe(250_000);
    expect(plBody.previous).toBeNull();

    const bs = await r()["balance-sheet"].$get({ param: param(), query: { asOf: "2026-12-31" } });
    expect(bs.status).toBe(200);
    const bsBody = BalanceSheetResponse.parse(await bs.json());
    expect(bsBody.netIncome.amount).toBe(250_000);
    expect(bsBody.totalAssets.amount).toBe(1_250_000);
    expect(bsBody.totalLiabilitiesAndEquity.amount).toBe(1_250_000);
    expect(bsBody.balanced).toBe(true);
  });

  it("compare=previous-year で前年と増減を含める", async () => {
    const next = await e["fiscal-periods"].$post({ param: param() });
    expect(next.status).toBe(201);
    await simple("売掛金", "売上高", 400_000, "2027-02-28");
    const res = await r()["profit-and-loss"].$get({
      param: param(),
      query: { from: "2027-01-01", to: "2027-12-31", compare: "previous-year" },
    });
    expect(res.status).toBe(200);
    const body = ProfitAndLossResponse.parse(await res.json());
    expect(body.previous).toEqual(YEAR);
    expect(body.netIncome).toEqual({ amount: 400_000, previous: 250_000, change: 150_000 });
    const sales = body.sections.find((s) => s.section === "PL_SALES");
    expect(sales?.rows.find((x) => x.name === "売上高")).toMatchObject({
      amount: 400_000,
      previous: 330_000,
      change: 70_000,
    });

    const bs = await r()["balance-sheet"].$get({
      param: param(),
      query: { asOf: "2027-12-31", compare: "previous-year" },
    });
    expect(bs.status).toBe(200);
    const bsBody = BalanceSheetResponse.parse(await bs.json());
    expect(bsBody.previousAsOf).toBe("2026-12-31");
    expect(bsBody.totalAssets.previous).toBe(1_250_000);
  });

  it("format=csv で BOM 付き UTF-8 の CSV を返す", async () => {
    const res = await r()["trial-balance"].$get({
      param: param(),
      query: { ...YEAR, format: "csv" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("\r\n");
    expect(text).toContain("普通預金");
  });

  it("FR-033: 売掛金がマイナスなら NEGATIVE_BALANCE の警告を含める", async () => {
    await simple("普通預金", "売掛金", 15_000, "2026-12-31");
    const res = await r()["balance-sheet"].$get({ param: param(), query: { asOf: "2026-12-31" } });
    const body = BalanceSheetResponse.parse(await res.json());
    expect(body.warnings).toEqual([
      {
        code: "NEGATIVE_BALANCE",
        message: expect.stringContaining("▲15,000"),
        details: { accountId: acc("売掛金"), accountName: "売掛金", balance: -15_000 },
      },
    ]);
  });
});

describe("GET /reports/* のエラーと警告", () => {
  it("期首残高が未登録なら OPENING_BALANCE_MISSING の警告を含める", async () => {
    await simple("現金", "売上高", 1_000, "2026-04-01");
    const res = await r()["balance-sheet"].$get({ param: param(), query: { asOf: "2026-12-31" } });
    expect(res.status).toBe(200);
    const body = BalanceSheetResponse.parse(await res.json());
    expect(body.warnings.map((w) => w.code)).toEqual(["OPENING_BALANCE_MISSING"]);
  });

  it("会計期間の外は OUT_OF_PERIOD（422）", async () => {
    const res = await r()["trial-balance"].$get({
      param: param(),
      query: { from: "2025-01-01", to: "2025-12-31" },
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("OUT_OF_PERIOD");
  });

  it("from が to より後、科目のない元帳は VALIDATION（400）・ACCOUNT_NOT_FOUND（422）", async () => {
    const bad = await r()["trial-balance"].$get({
      param: param(),
      query: { from: "2026-12-31", to: "2026-01-01" },
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
    const missing = await r()["general-ledger"].$get({
      param: param(),
      query: { ...YEAR, accountId: "0190f3a0-0000-7000-8000-000000000999" },
    });
    expect(missing.status).toBe(422);
    expect((await errorOf(missing)).code).toBe("ACCOUNT_NOT_FOUND");
  });
});
