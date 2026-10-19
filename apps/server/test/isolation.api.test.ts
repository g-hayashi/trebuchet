import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity } from "./helpers.ts";

let tmp: TempDataDir;
let entityA: string;
let entityB: string;
/** 事業体 A のデータに固有の値。B の応答に1つでも現れたら漏れ */
let markersA: string[];
let journalIdsA: string[];
let accountIdsA: Map<string, string>;
let accountIdsB: Map<string, string>;

const e = client.api.entities[":entityId"];

const MEMO_A = "事業体Aだけの摘要ZQX";
const DESC_A = "事業体Aだけの行の摘要QZX";
const PARTNER_A = "事業体Aだけの取引先XQZ";
const AMOUNT_A = 7_654_321;
const MEMO_B = "事業体Bの摘要";
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

async function accountsOf(entityId: string) {
  const res = await e.accounts.$get({ param: { entityId } });
  if (res.status !== 200) throw new Error(String(res.status));
  return new Map((await res.json()).accounts.map((a) => [a.name, a.id]));
}

const pick = (map: Map<string, string>, name: string) => {
  const id = map.get(name);
  if (id === undefined) throw new Error(`科目がない: ${name}`);
  return id;
};

async function postJournal(
  entityId: string,
  json: {
    date: string;
    memo?: string;
    lines: {
      side: "debit" | "credit";
      accountId: string;
      amount: number;
      description?: string;
      partnerId?: string;
    }[];
  },
) {
  const res = await e.journals.$post({ param: { entityId }, json });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()).journal;
}

beforeEach(async () => {
  tmp = useTempDataDir("server-isolation");

  entityA = await createTestEntity("個人事業A");
  accountIdsA = await accountsOf(entityA);
  const acc = (name: string) => pick(accountIdsA, name);
  const partnerRes = await e.partners.$post({
    param: { entityId: entityA },
    json: { name: PARTNER_A, honorific: "御中" },
  });
  if (partnerRes.status !== 201) throw new Error(String(partnerRes.status));
  const { partner } = await partnerRes.json();
  const opening = await e["fiscal-periods"][":year"]["opening-balances"].$put({
    param: { entityId: entityA, year: "2026" },
    json: [
      { accountId: acc("普通預金"), side: "debit", amount: 3_141_592 },
      { accountId: acc("元入金"), side: "credit", amount: 3_141_592 },
    ],
  });
  if (opening.status !== 200) throw new Error(`opening failed: ${opening.status}`);
  const sale = await postJournal(entityA, {
    date: "2026-03-31",
    memo: MEMO_A,
    lines: [
      {
        side: "debit",
        accountId: acc("売掛金"),
        amount: AMOUNT_A,
        description: DESC_A,
        partnerId: partner.id,
      },
      { side: "credit", accountId: acc("売上高"), amount: AMOUNT_A, description: DESC_A },
    ],
  });
  const cash = await postJournal(entityA, {
    date: "2026-04-01",
    memo: MEMO_A,
    lines: [
      { side: "debit", accountId: acc("現金"), amount: 1_234_567 },
      { side: "credit", accountId: acc("売上高"), amount: 1_234_567 },
    ],
  });
  journalIdsA = [sale.id, cash.id];
  markersA = [
    MEMO_A,
    DESC_A,
    PARTNER_A,
    partner.id,
    ...journalIdsA,
    ...sale.lines.map((l) => l.id),
    ...cash.lines.map((l) => l.id),
    ...accountIdsA.values(),
    String(AMOUNT_A),
    AMOUNT_A.toLocaleString("ja-JP"),
    "3141592",
    "3,141,592",
    "1234567",
    "1,234,567",
  ];

  const created = await client.api.entities.$post({
    json: { name: "株式会社B", kind: "corporation", fiscalStartMonth: 4, firstFiscalYear: 2026 },
  });
  if (created.status !== 201) throw new Error(`entity create failed: ${created.status}`);
  entityB = (await created.json()).entity.id;
  accountIdsB = await accountsOf(entityB);
  await postJournal(entityB, {
    date: "2026-05-01",
    memo: MEMO_B,
    lines: [
      { side: "debit", accountId: pick(accountIdsB, "現金"), amount: 1_000 },
      { side: "credit", accountId: pick(accountIdsB, "売上高"), amount: 1_000 },
    ],
  });
});
afterEach(() => tmp.cleanup());

function expectNoMarkersOfA(text: string) {
  for (const marker of markersA) expect(text, marker).not.toContain(marker);
}

/** 5つの帳票の JSON と CSV の本文 */
async function reportBodies(entityId: string, accountIds: Map<string, string>) {
  const r = e.reports;
  const param = { entityId };
  const accountId = pick(accountIds, "現金");
  const B_YEAR = { from: "2026-04-01", to: "2027-03-31" };
  const range = entityId === entityA ? YEAR : B_YEAR;
  const bodies: Record<string, string> = {};
  for (const format of ["json", "csv"] as const) {
    const responses = {
      "journal-book": await r["journal-book"].$get({ param, query: { ...range, format } }),
      "general-ledger": await r["general-ledger"].$get({
        param,
        query: { ...range, accountId, format },
      }),
      "trial-balance": await r["trial-balance"].$get({ param, query: { ...range, format } }),
      "profit-and-loss": await r["profit-and-loss"].$get({ param, query: { ...range, format } }),
      "balance-sheet": await r["balance-sheet"].$get({
        param,
        query: { asOf: range.to, format },
      }),
    };
    for (const [kind, res] of Object.entries(responses)) {
      expect(res.status, `${kind} ${format}`).toBe(200);
      bodies[`${kind}.${format}`] = await res.text();
    }
  }
  return bodies;
}

describe("事業体の間の分離（US6, FR-002, SC-007）", () => {
  it("US6-2: 種別「法人」の事業体を作成でき、個人用の初期の科目が入る", async () => {
    const list = await client.api.entities.$get();
    const { entities } = await list.json();
    expect(entities.find((x) => x.id === entityB)).toMatchObject({
      name: "株式会社B",
      kind: "corporation",
    });
    expect(accountIdsB.size).toBe(accountIdsA.size);
    expect([...accountIdsB.keys()].sort()).toEqual([...accountIdsA.keys()].sort());
    const shared = [...accountIdsB.values()].filter((id) => [...accountIdsA.values()].includes(id));
    expect(shared).toEqual([]);
  });

  it("前提: 事業体 A の帳票には A の摘要・金額が現れる（検出の陽性対照）", async () => {
    const bodies = await reportBodies(entityA, accountIdsA);
    expect(bodies["journal-book.json"]).toContain(MEMO_A);
    expect(bodies["journal-book.csv"]).toContain(DESC_A);
    expect(bodies["trial-balance.csv"]).toContain(String(AMOUNT_A));
  });

  it("US6-1: 事業体 B の5つの帳票（JSON・CSV）に、A の仕訳・科目・取引先・金額が一切現れない", async () => {
    const bodies = await reportBodies(entityB, accountIdsB);
    expect(Object.keys(bodies)).toHaveLength(10);
    expect(bodies["journal-book.json"]).toContain(MEMO_B);
    for (const text of Object.values(bodies)) expectNoMarkersOfA(text);
  });

  it("US6-1: 事業体 B の仕訳の検索に、A の仕訳が現れない（A の摘要・科目・取引先で検索しても空）", async () => {
    const param = { entityId: entityB };
    const all = await e.journals.$get({ param, query: { includeVoided: "true", limit: "200" } });
    if (all.status !== 200) throw new Error(String(all.status));
    expectNoMarkersOfA(await all.clone().text());
    expect((await all.json()).journals.map((j) => j.memo)).toEqual([MEMO_B]);

    const queries = [
      { q: MEMO_A },
      { q: DESC_A },
      { amountMin: String(AMOUNT_A), amountMax: String(AMOUNT_A) },
      { accountId: pick(accountIdsA, "売掛金") },
    ];
    for (const query of queries) {
      const res = await e.journals.$get({ param, query: { ...query, includeVoided: "true" } });
      if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(query)}`);
      const body = await res.json();
      expect(body.journals, JSON.stringify(query)).toEqual([]);
    }
  });

  it("A の仕訳の ID を B のパスで指定すると 404（詳細・履歴）", async () => {
    for (const journalId of journalIdsA) {
      const detail = await e.journals[":journalId"].$get({
        param: { entityId: entityB, journalId },
      });
      expect(detail.status).toBe(404);
      expectNoMarkersOfA((await detail.text()).replace(journalId, ""));

      const history = await e.journals[":journalId"].history.$get({
        param: { entityId: entityB, journalId },
      });
      expect(history.status).toBe(404);

      const own = await e.journals[":journalId"].$get({ param: { entityId: entityA, journalId } });
      expect(own.status).toBe(200);
    }
  });

  it("A の科目を B の総勘定元帳で指定しても、A の取引は返らない", async () => {
    const res = await e.reports["general-ledger"].$get({
      param: { entityId: entityB },
      query: { ...YEAR, accountId: pick(accountIdsA, "売掛金") },
    });
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).not.toContain(MEMO_A);
    expect(text).not.toContain(String(AMOUNT_A));
  });

  it("B の取引先・科目の一覧に A のマスタが現れない", async () => {
    const param = { entityId: entityB };
    const partners = await e.partners.$get({ param });
    expectNoMarkersOfA(await partners.text());
    const accounts = await e.accounts.$get({ param });
    expectNoMarkersOfA(await accounts.text());
  });
});
