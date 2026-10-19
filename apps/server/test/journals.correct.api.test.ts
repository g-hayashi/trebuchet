import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let accountIds: Map<string, string>;

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });
const journalParam = (journalId: string) => ({ param: { entityId, journalId } });

beforeEach(async () => {
  tmp = useTempDataDir("server-journals-correct");
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

type Line = {
  side: "debit" | "credit";
  accountId: string;
  amount: number;
  description?: string;
  partnerId?: string;
};

const lines = (debit: string, credit: string, amount: number): Line[] => [
  { side: "debit", accountId: acc(debit), amount },
  { side: "credit", accountId: acc(credit), amount },
];

async function create(json: { date: string; memo?: string; lines: Line[] }) {
  const res = await e.journals.$post({ param: param(), json });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()).journal;
}

const simple = (debit: string, credit: string, amount: number, date = "2026-10-31") =>
  create({ date, lines: lines(debit, credit, amount) });

const put = (
  journalId: string,
  json: { date: string; memo?: string; lines: Line[]; reason: string; version: number },
) => e.journals[":journalId"].$put({ ...journalParam(journalId), json });

const voidIt = (journalId: string, json: { reason: string; version: number }) =>
  e.journals[":journalId"].void.$post({ ...journalParam(journalId), json });

describe("PUT /journals/:id（US3, FR-019, FR-020）", () => {
  it("理由を付けて訂正すると 200 で version が +1 され、内容が置き換わる", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const res = await put(j.id, {
      date: "2026-10-31",
      memo: "訂正後",
      lines: lines("売掛金", "売上高", 500_000),
      reason: "金額の誤り",
      version: 1,
    });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { journal } = await res.json();
    expect(journal).toMatchObject({ id: j.id, journalNo: 1, version: 2, memo: "訂正後" });
    expect(journal.lines.map((l) => l.amount)).toEqual([500_000, 500_000]);
  });

  it("US3-3: 理由が空欄なら 422 REASON_REQUIRED", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const res = await put(j.id, {
      date: "2026-10-31",
      lines: lines("売掛金", "売上高", 500_000),
      reason: "  ",
      version: 1,
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("REASON_REQUIRED");
  });

  it("理由・version がなければ 400 VALIDATION", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const res = await e.journals[":journalId"].$put({
      ...journalParam(j.id),
      // @ts-expect-error reason と version がない
      json: { date: "2026-10-31", lines: lines("売掛金", "売上高", 1) },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("古い version は 409 VERSION_CONFLICT", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const body = {
      date: "2026-10-31",
      lines: lines("売掛金", "売上高", 500_000),
      reason: "金額の誤り",
      version: 1,
    };
    expect((await put(j.id, body)).status).toBe(200);
    const stale = await put(j.id, body);
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { currentVersion: 2 },
    });
  });

  it("貸借が一致しない訂正は 422 UNBALANCED、ない仕訳は 404 JOURNAL_NOT_FOUND", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const unbalanced = await put(j.id, {
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: acc("売掛金"), amount: 500_000 },
        { side: "credit", accountId: acc("売上高"), amount: 495_000 },
      ],
      reason: "金額の誤り",
      version: 1,
    });
    expect(unbalanced.status).toBe(422);
    expect((await errorOf(unbalanced)).code).toBe("UNBALANCED");

    const missing = await put("0190f3a0-0000-7000-8000-000000000999", {
      date: "2026-10-31",
      lines: lines("売掛金", "売上高", 1),
      reason: "x",
      version: 1,
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("JOURNAL_NOT_FOUND");
  });

  it("US3-5: 締め済みの年度の仕訳の訂正・取消は 409 PERIOD_CLOSED で訂正仕訳を案内する", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    openTenant(entityId)
      .$client.prepare("UPDATE fiscal_periods SET status = 'closed', closed_at = ?")
      .run("2027-03-01T00:00:00.000Z");
    const corrected = await put(j.id, {
      date: "2026-10-31",
      lines: lines("売掛金", "売上高", 500_000),
      reason: "金額の誤り",
      version: 1,
    });
    expect(corrected.status).toBe(409);
    expect(await errorOf(corrected)).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { suggest: "correcting_entry" },
    });
    const voided = await voidIt(j.id, { reason: "二重登録", version: 1 });
    expect(voided.status).toBe(409);
    expect((await errorOf(voided)).code).toBe("PERIOD_CLOSED");
  });
});

describe("POST /journals/:id/void（US3, FR-021）", () => {
  it("US3-2: 理由を付けて取り消すと 200 で voided になり、行は残る", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const res = await voidIt(j.id, { reason: "二重登録", version: 1 });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { journal } = await res.json();
    expect(journal).toMatchObject({ id: j.id, status: "voided", version: 2 });
    expect(journal.lines).toEqual(j.lines);
  });

  it("理由が空欄なら 422 REASON_REQUIRED、取消済みの取消は 409 JOURNAL_VOIDED", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const blank = await voidIt(j.id, { reason: "", version: 1 });
    expect(blank.status).toBe(422);
    expect((await errorOf(blank)).code).toBe("REASON_REQUIRED");
    expect((await voidIt(j.id, { reason: "二重登録", version: 1 })).status).toBe(200);
    const again = await voidIt(j.id, { reason: "二重登録", version: 2 });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("JOURNAL_VOIDED");
  });
});

describe("GET /journals/:id/history（US3, FR-020, SC-005）", () => {
  it("登録・訂正・取消の履歴を、変更前後の内容・日時・理由つきで古い順に返す", async () => {
    const j = await simple("売掛金", "売上高", 495_000);
    const corrected = await put(j.id, {
      date: "2026-10-31",
      lines: lines("売掛金", "売上高", 500_000),
      reason: "金額の誤り",
      version: 1,
    });
    if (corrected.status !== 200) throw new Error(String(corrected.status));
    const after = (await corrected.json()).journal;
    await voidIt(j.id, { reason: "二重登録", version: 2 });

    const res = await e.journals[":journalId"].history.$get(journalParam(j.id));
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { history } = await res.json();
    expect(history.map((h) => [h.action, h.reason])).toEqual([
      ["create", null],
      ["correct", "金額の誤り"],
      ["void", "二重登録"],
    ]);
    expect(history[0]).toMatchObject({ before: null, after: j });
    expect(history[1]).toMatchObject({ before: j, after });
    expect(history[2]?.before).toEqual(after);
    expect(history[2]?.after).toMatchObject({ status: "voided", version: 3 });
    for (const h of history) expect(h.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const missing = await e.journals[":journalId"].history.$get(
      journalParam("0190f3a0-0000-7000-8000-000000000999"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("GET /journals/:id の訂正元・訂正仕訳（US3, FR-019a）", () => {
  it("訂正仕訳を起票すると、元の仕訳と訂正仕訳を相互にたどれる", async () => {
    const original = await simple("売掛金", "売上高", 495_000, "2026-12-20");
    const db = openTenant(entityId).$client;
    db.prepare("UPDATE fiscal_periods SET status = 'closed'").run();
    const nextYear = await e["fiscal-periods"].$post({ param: param() });
    expect(nextYear.status).toBe(201);

    const fixRes = await e.journals.$post({
      param: param(),
      json: {
        date: "2027-01-10",
        memo: "No.1 の訂正",
        correctsJournalId: original.id,
        lines: lines("売掛金", "売上高", 5000),
      },
    });
    expect(fixRes.status).toBe(201);
    if (fixRes.status !== 201) return;
    const fix = (await fixRes.json()).journal;
    expect(fix.correctsJournalId).toBe(original.id);

    const res = await e.journals[":journalId"].$get(journalParam(original.id));
    if (res.status !== 200) throw new Error(String(res.status));
    expect(await res.json()).toEqual({
      journal: original,
      correctsJournal: null,
      correctingJournals: [{ id: fix.id, journalNo: 2, date: "2027-01-10", status: "active" }],
    });
    const back = await e.journals[":journalId"].$get(journalParam(fix.id));
    if (back.status !== 200) throw new Error(String(back.status));
    expect((await back.json()).correctsJournal).toEqual({
      id: original.id,
      journalNo: 1,
      date: "2026-12-20",
      status: "active",
    });
  });

  it("締めていない年度の仕訳を訂正元にすると 400 VALIDATION", async () => {
    const original = await simple("売掛金", "売上高", 495_000);
    const res = await e.journals.$post({
      param: param(),
      json: {
        date: "2026-11-01",
        correctsJournalId: original.id,
        lines: lines("売掛金", "売上高", 1),
      },
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "VALIDATION",
      details: { field: "correctsJournalId" },
    });
  });
});

describe("GET /journals の検索（US3, FR-023）", () => {
  it("US3-4: 日付の範囲・金額の範囲・取引先を組み合わせて検索できる", async () => {
    const partnerRes = await e.partners.$post({
      param: param(),
      json: { name: "取引先A", honorific: "御中" },
    });
    if (partnerRes.status !== 201) throw new Error(String(partnerRes.status));
    const { partner } = await partnerRes.json();
    const withPartner = (amount: number, date: string) =>
      create({
        date,
        lines: [
          { side: "debit", accountId: acc("売掛金"), amount, partnerId: partner.id },
          { side: "credit", accountId: acc("売上高"), amount },
        ],
      });
    const hit = await withPartner(300_000, "2026-06-15");
    await withPartner(300_000, "2026-08-01");
    await withPartner(50_000, "2026-06-20");
    await simple("売掛金", "売上高", 300_000, "2026-06-16");

    const res = await e.journals.$get({
      param: param(),
      query: {
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        amountMin: "100000",
        amountMax: "400000",
        partnerId: partner.id,
      },
    });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const body = await res.json();
    expect(body.journals.map((j) => j.id)).toEqual([hit.id]);
    expect(body.nextCursor).toBeNull();
  });

  it("取消済みは既定で検索結果に出ない。includeVoided=true で出る", async () => {
    const a = await simple("地代家賃", "普通預金", 80_000, "2026-01-31");
    const b = await simple("地代家賃", "普通預金", 80_000, "2026-02-28");
    await voidIt(a.id, { reason: "二重登録", version: 1 });

    const active = await e.journals.$get({ param: param(), query: { accountId: acc("地代家賃") } });
    if (active.status !== 200) throw new Error(String(active.status));
    expect((await active.json()).journals.map((j) => j.id)).toEqual([b.id]);

    const all = await e.journals.$get({
      param: param(),
      query: { accountId: acc("地代家賃"), includeVoided: "true" },
    });
    if (all.status !== 200) throw new Error(String(all.status));
    expect((await all.json()).journals.map((j) => [j.id, j.status])).toEqual([
      [b.id, "active"],
      [a.id, "voided"],
    ]);
  });

  it("limit と cursor でページを分けて返す", async () => {
    for (const day of ["01", "02", "03", "04", "05"]) {
      await simple("売掛金", "売上高", Number(day), `2026-10-${day}`);
    }
    const first = await e.journals.$get({ param: param(), query: { limit: "2" } });
    if (first.status !== 200) throw new Error(String(first.status));
    const page1 = await first.json();
    expect(page1.journals.map((j) => j.date)).toEqual(["2026-10-05", "2026-10-04"]);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = await e.journals.$get({
      param: param(),
      query: { limit: "2", cursor: page1.nextCursor ?? "" },
    });
    if (second.status !== 200) throw new Error(String(second.status));
    expect((await second.json()).journals.map((j) => j.date)).toEqual(["2026-10-03", "2026-10-02"]);
  });

  it("不正な検索条件は 400 VALIDATION", async () => {
    const res = await e.journals.$get({ param: param(), query: { amountMin: "-5" } });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });
});
