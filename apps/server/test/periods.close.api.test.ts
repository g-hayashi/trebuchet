import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let accountIds: Map<string, string>;

const e = client.api.entities[":entityId"];
const periods = e["fiscal-periods"];
const param = () => ({ entityId });
const yearParam = (year: string) => ({ param: { entityId, year } });

beforeEach(async () => {
  tmp = useTempDataDir("server-periods-close");
  entityId = await createTestEntity();
  const res = await e.accounts.$get({ param: param() });
  if (res.status !== 200) throw new Error(String(res.status));
  accountIds = new Map((await res.json()).accounts.map((a) => [a.name, a.id]));
});
afterEach(() => tmp.cleanup());

const acc = (name: string) => {
  const id = accountIds.get(name);
  if (id === undefined) throw new Error(`科目がない: ${name}`);
  return id;
};

const sale = (date = "2026-10-31", amount = 495_000) => ({
  date,
  lines: [
    { side: "debit" as const, accountId: acc("売掛金"), amount },
    { side: "credit" as const, accountId: acc("売上高"), amount },
  ],
});

const postJournal = (date?: string) => e.journals.$post({ param: param(), json: sale(date) });
const close = (year = "2026") => periods[":year"].close.$post(yearParam(year));
const reopen = (reason: string, year = "2026") =>
  periods[":year"].reopen.$post({ ...yearParam(year), json: { reason } });

async function period2026() {
  const res = await periods.$get({ param: param() });
  if (res.status !== 200) throw new Error(String(res.status));
  const found = (await res.json()).fiscalPeriods.find((p) => p.fiscalYear === 2026);
  if (found === undefined) throw new Error("2026 年度がない");
  return found;
}

describe("POST /fiscal-periods/:year/close・reopen（US5, FR-024, FR-025）", () => {
  it("US5-1: 締めると 200 で closed になり、2026 年の日付の仕訳の登録は 409 PERIOD_CLOSED", async () => {
    const res = await close();
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { fiscalPeriod } = await res.json();
    expect(fiscalPeriod).toMatchObject({ fiscalYear: 2026, status: "closed" });
    expect(fiscalPeriod.closedAt).toEqual(expect.any(String));
    expect(await period2026()).toEqual(fiscalPeriod);

    const created = await postJournal();
    expect(created.status).toBe(409);
    expect(await errorOf(created)).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2026, suggest: "correcting_entry" },
    });
  });

  it("締め済みの年度の仕訳の訂正・取消は 409 PERIOD_CLOSED", async () => {
    const created = await postJournal();
    if (created.status !== 201) throw new Error(String(created.status));
    const { journal } = await created.json();
    await close();
    const journalParam = { param: { entityId, journalId: journal.id } };

    const corrected = await e.journals[":journalId"].$put({
      ...journalParam,
      json: { ...sale("2026-10-31", 500_000), reason: "金額の誤り", version: 1 },
    });
    expect(corrected.status).toBe(409);
    expect((await errorOf(corrected)).code).toBe("PERIOD_CLOSED");
    const voided = await e.journals[":journalId"].void.$post({
      ...journalParam,
      json: { reason: "二重登録", version: 1 },
    });
    expect(voided.status).toBe(409);
    expect((await errorOf(voided)).code).toBe("PERIOD_CLOSED");
  });

  it("締め済みの年度の期首残高は取得でき（status = closed）、置き換えは 409 PERIOD_CLOSED", async () => {
    await close();
    const got = await periods[":year"]["opening-balances"].$get(yearParam("2026"));
    expect(got.status).toBe(200);
    if (got.status !== 200) return;
    expect((await got.json()).fiscalPeriod.status).toBe("closed");

    const put = await periods[":year"]["opening-balances"].$put({
      ...yearParam("2026"),
      json: [
        { accountId: acc("現金"), side: "debit", amount: 1000 },
        { accountId: acc("元入金"), side: "credit", amount: 1000 },
      ],
    });
    expect(put.status).toBe(409);
    expect((await errorOf(put)).code).toBe("PERIOD_CLOSED");
  });

  it("締め済みの年度を再度締めても 200 で、締めた日時は変わらない", async () => {
    const first = await close();
    if (first.status !== 200) throw new Error(String(first.status));
    const { fiscalPeriod } = await first.json();
    const again = await close();
    expect(again.status).toBe(200);
    if (again.status !== 200) return;
    expect((await again.json()).fiscalPeriod).toEqual(fiscalPeriod);
  });

  it.each(["", "   "])(
    "US5-2: 理由なし（%j）の解除は 422 REASON_REQUIRED で、締め済みのまま",
    async (reason) => {
      await close();
      const res = await reopen(reason);
      expect(res.status).toBe(422);
      expect(await errorOf(res)).toMatchObject({
        code: "REASON_REQUIRED",
        details: { field: "reason" },
      });
      expect((await period2026()).status).toBe("closed");
    },
  );

  it("理由のプロパティがなければ 400 VALIDATION", async () => {
    await close();
    const res = await periods[":year"].reopen.$post({
      ...yearParam("2026"),
      // @ts-expect-error reason がない
      json: {},
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("US5-2: 理由を付けて解除すると 200 で open に戻り、再び登録できる", async () => {
    await close();
    const res = await reopen("修正申告のため");
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).fiscalPeriod).toMatchObject({ status: "open", closedAt: null });
    expect((await postJournal()).status).toBe(201);
  });

  it("ない年度・年度の形式の誤りは 400 VALIDATION", async () => {
    for (const res of [await close("2030"), await close("abc"), await reopen("x", "2030")]) {
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });
});

describe("GET /fiscal-periods/history（FR-025）", () => {
  it("締めと解除の記録を、日時・年度・操作・理由とともに記録の順で返す", async () => {
    const empty = await periods.history.$get({ param: param() });
    expect(empty.status).toBe(200);
    if (empty.status !== 200) return;
    expect((await empty.json()).history).toEqual([]);

    await close();
    await reopen("  修正申告のため ");
    await close();

    const res = await periods.history.$get({ param: param() });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { history } = await res.json();
    expect(
      history.map(({ fiscalYear, action, reason }) => ({ fiscalYear, action, reason })),
    ).toEqual([
      { fiscalYear: 2026, action: "close", reason: null },
      { fiscalYear: 2026, action: "reopen", reason: "修正申告のため" },
      { fiscalYear: 2026, action: "close", reason: null },
    ]);
    const times = history.map((h) => h.occurredAt);
    expect(times).toEqual([...times].sort());
  });
});
