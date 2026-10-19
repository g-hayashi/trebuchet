import { openTenant } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;
let accountIds: Map<string, string>;

const e = client.api.entities[":entityId"];
const param = () => ({ entityId });

beforeEach(async () => {
  tmp = useTempDataDir("server-journals");
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

const post = (json: { date: string; memo?: string; lines: Line[] }) =>
  e.journals.$post({ param: param(), json });

const simple = (debit: string, credit: string, amount: number, date = "2026-10-31") =>
  post({
    date,
    lines: [
      { side: "debit", accountId: acc(debit), amount },
      { side: "credit", accountId: acc(credit), amount },
    ],
  });

describe("POST /journals（US2）", () => {
  it("US2-1: 売掛金 495,000 / 売上高 495,000 は 201 で仕訳番号が採番される", async () => {
    const partnerRes = await e.partners.$post({
      param: param(),
      json: { name: "取引先A", honorific: "御中" },
    });
    if (partnerRes.status !== 201) throw new Error(String(partnerRes.status));
    const { partner } = await partnerRes.json();

    const res = await post({
      date: "2026-10-31",
      memo: "10月分",
      lines: [
        {
          side: "debit",
          accountId: acc("売掛金"),
          amount: 495_000,
          description: "10月分",
          partnerId: partner.id,
        },
        { side: "credit", accountId: acc("売上高"), amount: 495_000, description: "10月分" },
      ],
    });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const body = await res.json();
    expect(body.warnings).toEqual([]);
    expect(body.journal).toMatchObject({
      journalNo: 1,
      date: "2026-10-31",
      memo: "10月分",
      status: "active",
      version: 1,
      correctsJournalId: null,
    });
    expect(body.journal.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        side: "debit",
        accountId: acc("売掛金"),
        amount: 495_000,
        partnerId: partner.id,
        description: "10月分",
        taxCategory: "OUT_OF_SCOPE",
        taxAmount: 0,
        tagIds: [],
      }),
      expect.objectContaining({ lineNo: 2, side: "credit", accountId: acc("売上高") }),
    ]);
  });

  it("US2-2: 普通預金 487,037 ＋ 事業主貸 7,963 / 売掛金 495,000 は1つの仕訳として登録される", async () => {
    await simple("売掛金", "売上高", 495_000);
    const res = await post({
      date: "2026-11-30",
      lines: [
        { side: "debit", accountId: acc("普通預金"), amount: 487_037 },
        { side: "debit", accountId: acc("事業主貸"), amount: 7963, description: "源泉所得税" },
        { side: "credit", accountId: acc("売掛金"), amount: 495_000 },
      ],
    });
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const { journal } = await res.json();
    expect(journal.journalNo).toBe(2);
    expect(journal.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 487_037],
      ["debit", 7963],
      ["credit", 495_000],
    ]);
  });

  it("US2-3: 借方 500,000 / 貸方 495,000 は 422 UNBALANCED で diff: 5000", async () => {
    const res = await post({
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: acc("売掛金"), amount: 500_000 },
        { side: "credit", accountId: acc("売上高"), amount: 495_000 },
      ],
    });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error).toMatchObject({
      code: "UNBALANCED",
      details: { debit: 500_000, credit: 495_000, diff: 5000 },
    });
  });

  it("US2-4: 金額 0 は 400 VALIDATION", async () => {
    const res = await simple("売掛金", "売上高", 0);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("US2-4: 借方だけの仕訳は 400 VALIDATION", async () => {
    const res = await post({
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: acc("売掛金"), amount: 1000 },
        { side: "debit", accountId: acc("現金"), amount: 1000 },
      ],
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("US2-4: 会計期間外は 422 OUT_OF_PERIOD。最後の期間より後なら会計期間の作成を提案する", async () => {
    const after = await simple("売掛金", "売上高", 1000, "2027-01-05");
    expect(after.status).toBe(422);
    expect(await errorOf(after)).toMatchObject({
      code: "OUT_OF_PERIOD",
      details: { date: "2027-01-05", suggest: "create_fiscal_period" },
    });
    const before = await simple("売掛金", "売上高", 1000, "2025-12-31");
    expect(before.status).toBe(422);
    const error = await errorOf(before);
    expect(error.code).toBe("OUT_OF_PERIOD");
    expect(error.details).not.toHaveProperty("suggest");
  });

  it("US2-4: 存在しない科目・使用停止の科目は 422", async () => {
    const missing = await post({
      date: "2026-10-31",
      lines: [
        { side: "debit", accountId: "0190f3a0-0000-7000-8000-000000000999", amount: 1000 },
        { side: "credit", accountId: acc("売上高"), amount: 1000 },
      ],
    });
    expect(missing.status).toBe(422);
    expect(await errorOf(missing)).toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
      details: { lineIndex: 0, field: "accountId" },
    });

    await e.accounts[":accountId"].$patch({
      param: { entityId, accountId: acc("雑費") },
      json: { isActive: false },
    });
    const inactive = await simple("雑費", "現金", 1000);
    expect(inactive.status).toBe(422);
    expect((await errorOf(inactive)).code).toBe("ACCOUNT_INACTIVE");
  });

  it("US2-4: 締め済みの年度の日付は 409 PERIOD_CLOSED", async () => {
    openTenant(entityId)
      .$client.prepare("UPDATE fiscal_periods SET status = 'closed', closed_at = ?")
      .run("2027-03-01T00:00:00.000Z");
    const res = await simple("売掛金", "売上高", 1000);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2026, suggest: "correcting_entry" },
    });
  });

  it("FR-018: 直前の仕訳と同じ日付・科目・金額なら 201 で POSSIBLE_DUPLICATE の警告を返す", async () => {
    await simple("地代家賃", "普通預金", 80_000);
    const res = await simple("地代家賃", "普通預金", 80_000);
    expect(res.status).toBe(201);
    if (res.status !== 201) return;
    const body = await res.json();
    expect(body.journal.journalNo).toBe(2);
    expect(body.warnings).toEqual([
      expect.objectContaining({ code: "POSSIBLE_DUPLICATE", message: expect.any(String) }),
    ]);
  });
});

describe("GET /journals", () => {
  it("GET /journals/:journalId で仕訳と行が返る。ない仕訳は 404", async () => {
    const created = await simple("売掛金", "売上高", 495_000);
    if (created.status !== 201) throw new Error(String(created.status));
    const { journal } = await created.json();

    const res = await e.journals[":journalId"].$get({
      param: { entityId, journalId: journal.id },
    });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).journal).toEqual(journal);

    const missing = await e.journals[":journalId"].$get({
      param: { entityId, journalId: "0190f3a0-0000-7000-8000-000000000999" },
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("JOURNAL_NOT_FOUND");
  });

  it("GET /journals は新しい順（日付の降順、同じ日付は仕訳番号の降順）", async () => {
    await simple("売掛金", "売上高", 1, "2026-10-31");
    await simple("売掛金", "売上高", 2, "2026-01-05");
    await simple("売掛金", "売上高", 3, "2026-10-31");
    const res = await e.journals.$get({ param: param(), query: {} });
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    expect((await res.json()).journals.map((j) => j.journalNo)).toEqual([3, 1, 2]);

    const limited = await e.journals.$get({ param: param(), query: { limit: "2" } });
    if (limited.status !== 200) throw new Error(String(limited.status));
    expect((await limited.json()).journals.map((j) => j.journalNo)).toEqual([3, 1]);
  });
});
