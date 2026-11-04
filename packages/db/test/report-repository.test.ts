import { randomUUIDv7 } from "node:crypto";
import {
  addSubAccount,
  createJournal,
  createNextFiscalPeriod,
  type JournalDraft,
  replaceOpeningBalances,
  upsertPartner,
  voidJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  NOW,
  type TempDataDir,
  useTempDataDir,
} from "../src/testing.ts";

let tmp: TempDataDir;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => NOW };
const deps = () => ({ ledger, masters, ids, clock });

beforeEach(() => {
  tmp = useTempDataDir("report-repo");
  const db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => accountIdOf(masters, name);

function post(draft: JournalDraft) {
  const r = createJournal(deps(), draft);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.journal;
}

const cash = (amount: number, date: string): JournalDraft => ({
  date,
  lines: [
    { side: "debit", accountId: accountId("現金"), amount },
    { side: "credit", accountId: accountId("売上高"), amount },
  ],
});

describe("DrizzleLedgerRepository の帳票用の読み取り（R12）", () => {
  it("linesInRange: 期間内（両端を含む）の有効な仕訳の行を、日付・仕訳番号・行番号の順に返す", () => {
    post(cash(100, "2026-03-01"));
    post(cash(200, "2026-01-31"));
    const voided = post(cash(300, "2026-02-01"));
    post(cash(400, "2026-01-01"));
    post(cash(500, "2026-03-02"));
    expect(voidJournal(deps(), voided.id, { reason: "二重登録", version: 1 }).ok).toBe(true);

    const lines = ledger.linesInRange("2026-01-01", "2026-03-01");
    expect(lines.map((l) => [l.date, l.journalNo, l.lineNo, l.amount])).toEqual([
      ["2026-01-01", 4, 1, 400],
      ["2026-01-01", 4, 2, 400],
      ["2026-01-31", 2, 1, 200],
      ["2026-01-31", 2, 2, 200],
      ["2026-03-01", 1, 1, 100],
      ["2026-03-01", 1, 2, 100],
    ]);
    expect(lines.every((l) => l.status === "active")).toBe(true);
  });

  it("linesInRange: 科目・補助科目・取引先の名前と、仕訳のメモ・行の項目を含める", () => {
    const repo = { repo: masters, ids, clock };
    const sub = addSubAccount(repo, accountId("普通預金"), "A銀行");
    const partner = upsertPartner(repo, { name: "取引先A", honorific: "御中" });
    if (!sub.ok || !partner.ok) throw new Error("マスタの登録に失敗");
    const j = post({
      date: "2026-05-10",
      memo: "5月分",
      lines: [
        {
          side: "debit",
          accountId: accountId("普通預金"),
          subAccountId: sub.value.id,
          amount: 1_100,
          description: "入金",
        },
        {
          side: "credit",
          accountId: accountId("売上高"),
          partnerId: partner.value.id,
          amount: 1_100,
        },
      ],
    });
    expect(ledger.linesInRange("2026-01-01", "2026-12-31")).toEqual([
      {
        journalId: j.id,
        journalNo: 1,
        date: "2026-05-10",
        memo: "5月分",
        createdAt: j.createdAt,
        status: "active",
        lineNo: 1,
        side: "debit",
        accountId: accountId("普通預金"),
        accountName: "普通預金",
        subAccountId: sub.value.id,
        subAccountName: "A銀行",
        amount: 1_100,
        taxCategory: expect.any(String),
        taxAmount: expect.any(Number),
        partnerId: null,
        partnerName: null,
        description: "入金",
      },
      {
        journalId: j.id,
        journalNo: 1,
        date: "2026-05-10",
        memo: "5月分",
        createdAt: j.createdAt,
        status: "active",
        lineNo: 2,
        side: "credit",
        accountId: accountId("売上高"),
        accountName: "売上高",
        subAccountId: null,
        subAccountName: null,
        amount: 1_100,
        taxCategory: expect.any(String),
        taxAmount: expect.any(Number),
        partnerId: partner.value.id,
        partnerName: "取引先A",
        description: null,
      },
    ]);
  });

  it("openingBalances: 年度の期首残高を返し、未登録の年度は空", () => {
    const repo = { repo: masters, ids, clock };
    expect(createNextFiscalPeriod(repo).ok).toBe(true);
    const saved = replaceOpeningBalances(repo, 2027, [
      { accountId: accountId("現金"), side: "debit", amount: 5_000 },
      { accountId: accountId("元入金"), side: "credit", amount: 5_000 },
    ]);
    expect(saved.ok).toBe(true);
    expect(ledger.openingBalances(2026)).toEqual([]);
    expect(
      ledger
        .openingBalances(2027)
        .map((o) => [o.accountId, o.side, o.amount])
        .sort(),
    ).toEqual(
      [
        [accountId("現金"), "debit", 5_000],
        [accountId("元入金"), "credit", 5_000],
      ].sort(),
    );
    expect(ledger.openingBalances(2030)).toEqual([]);
  });
});
