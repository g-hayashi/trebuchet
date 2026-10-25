import { randomUUIDv7 } from "node:crypto";
import {
  type AuditEntry,
  createJournal,
  type FiscalPeriod,
  type Journal,
  type JournalDraft,
  type NewJournal,
  ok,
  validateJournal,
} from "@trebuchet/domain";
import { balancedLinesArb, dateInPeriodArb, fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  NOW,
  type TempDataDir,
  useTempDataDir,
} from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let period: FiscalPeriod;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => NOW };

beforeEach(() => {
  tmp = useTempDataDir("ledger-repo");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  const first = masters.listFiscalPeriods()[0];
  if (first === undefined) throw new Error("会計期間がない");
  period = first;
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => accountIdOf(masters, name);

const context = () => ({
  accounts: masters.listAccounts(),
  subAccounts: masters.listSubAccounts(),
  partners: masters.listPartners(),
  tags: masters.listTags(),
  periods: masters.listFiscalPeriods(),
  taxSettings: masters.listTaxSettings(),
  taxRates: masters.listTaxRates(),
});

/** 下書きを検証し、ID と仕訳番号を付けて NewJournal にする */
function newJournal(draft: JournalDraft, journalNo: number, ctx = context()): NewJournal {
  const valid = validateJournal(draft, ctx);
  if (!valid.ok) throw new Error(JSON.stringify(valid.error));
  return {
    ...valid.value,
    id: randomUUIDv7(),
    journalNo,
    createdAt: clock.now(),
    lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
  };
}

const sale = (amount = 495_000, date = "2026-10-31"): JournalDraft => ({
  date,
  memo: "10月分",
  lines: [
    { side: "debit", accountId: accountId("売掛金"), amount },
    { side: "credit", accountId: accountId("売上高"), amount },
  ],
});

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const audit = (targetId: string): AuditEntry => ({
  id: randomUUIDv7(),
  occurredAt: clock.now(),
  targetType: "journal",
  targetId,
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
});

describe("DrizzleLedgerRepository（US2）", () => {
  it("仕訳・行（補助科目・取引先・摘要）・タグを保存し、同じ内容で取得できる", () => {
    const receivable = accountId("売掛金");
    const sub = { id: randomUUIDv7(), accountId: receivable, name: "A社", isActive: true };
    masters.insertSubAccount(sub);
    const partner = {
      id: randomUUIDv7(),
      name: "取引先A",
      honorific: null,
      memo: null,
      isActive: true,
    };
    masters.insertPartner(partner);
    const tags = [
      { id: randomUUIDv7(), name: "定期" },
      { id: randomUUIDv7(), name: "源泉" },
    ];
    for (const t of tags) masters.insertTag(t);

    const draft: JournalDraft = {
      date: "2026-10-31",
      memo: "10月分",
      lines: [
        { side: "debit", accountId: accountId("普通預金"), amount: 487_037 },
        {
          side: "debit",
          accountId: accountId("事業主貸"),
          amount: 7963,
          description: "源泉所得税",
          tagIds: [tags[1]?.id ?? "", tags[0]?.id ?? ""],
        },
        {
          side: "credit",
          accountId: receivable,
          subAccountId: sub.id,
          partnerId: partner.id,
          amount: 495_000,
          tagIds: [tags[0]?.id ?? ""],
        },
      ],
    };
    const saved = ledger.insertJournal(newJournal(draft, 1));
    expect(saved).toMatchObject({
      journalNo: 1,
      date: "2026-10-31",
      fiscalPeriodId: period.id,
      memo: "10月分",
      status: "active",
      source: "manual",
      version: 1,
      correctsJournalId: null,
      updatedAt: saved.createdAt,
    });
    expect(saved.lines.map((l) => [l.lineNo, l.amount, l.tagIds])).toEqual([
      [1, 487_037, []],
      [2, 7963, [tags[1]?.id, tags[0]?.id]],
      [3, 495_000, [tags[0]?.id]],
    ]);
    expect(saved.lines[2]).toMatchObject({ subAccountId: sub.id, partnerId: partner.id });
    expect(ledger.getJournal(saved.id)).toEqual(saved);
    expect(ledger.getJournal(randomUUIDv7())).toBeUndefined();
    expect(count("journal_line_tags")).toBe(3);
  });

  it("nextJournalNo は max(journal_no) + 1 で、トランザクション内で採番され、ロールバックで戻る", () => {
    expect(ledger.nextJournalNo()).toBe(1);
    ledger.transaction((tx) => {
      const no = tx.nextJournalNo();
      expect(no).toBe(1);
      tx.insertJournal(newJournal(sale(), no));
      expect(tx.nextJournalNo()).toBe(2);
      return ok(null);
    });
    expect(ledger.nextJournalNo()).toBe(2);
    expect(() =>
      ledger.transaction((tx) => {
        tx.insertJournal(newJournal(sale(1000), tx.nextJournalNo()));
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(ledger.nextJournalNo()).toBe(2);
  });

  it("仕訳番号の重複は DB が拒否する（INV-8）", () => {
    ledger.insertJournal(newJournal(sale(), 1));
    expect(() => ledger.insertJournal(newJournal(sale(), 1))).toThrow();
    expect(count("journals")).toBe(1);
    expect(count("journal_lines")).toBe(2);
  });

  it("lastJournal は仕訳番号が最大の仕訳、recentJournals は日付の降順・仕訳番号の降順", () => {
    expect(ledger.lastJournal()).toBeUndefined();
    const a = ledger.insertJournal(newJournal(sale(1, "2026-10-31"), 1));
    const b = ledger.insertJournal(newJournal(sale(2, "2026-01-05"), 2));
    const c = ledger.insertJournal(newJournal(sale(3, "2026-10-31"), 3));
    expect(ledger.lastJournal()).toEqual(c);
    expect(ledger.recentJournals(10).map((j) => j.journalNo)).toEqual([3, 1, 2]);
    expect(ledger.recentJournals(2)).toEqual([c, a]);
    expect(b.journalNo).toBe(2);
  });

  it("任意の仕訳を 1,000 件登録しても v_unbalanced_journals は空（INV-1, INV-2）", () => {
    const ctx = context();
    const journalArb = fc.record({
      date: dateInPeriodArb(period),
      lines: balancedLinesArb(ctx.accounts),
    });
    fc.assert(
      fc.property(fc.array(journalArb, { minLength: 1000, maxLength: 1000 }), (drafts) => {
        ledger.transaction((tx) => {
          for (const draft of drafts) tx.insertJournal(newJournal(draft, tx.nextJournalNo(), ctx));
          return ok(null);
        });
        expect(db.$client.prepare("SELECT * FROM v_unbalanced_journals").all()).toEqual([]);
      }),
      { numRuns: 2 },
    );
    expect(count("journals")).toBe(2000);
  });

  it("トランザクション内で例外が起きたら、仕訳も audit_log も残らない", () => {
    expect(() =>
      ledger.transaction((tx) => {
        const j = tx.insertJournal(newJournal(sale(), tx.nextJournalNo()));
        tx.appendAudit(audit(j.id));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count("journals")).toBe(0);
    expect(count("journal_lines")).toBe(0);
    expect(count("audit_log")).toBe(0);
  });

  it("createJournal と結合すると、仕訳と audit_log の create が同じトランザクションで保存される", () => {
    const r = createJournal({ ledger, masters, ids, clock }, sale());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const journal: Journal = r.value.journal;
    expect(ledger.getJournal(journal.id)).toEqual(journal);
    const rows = db.$client
      .prepare("SELECT target_id, action, after_json FROM audit_log WHERE target_type = 'journal'")
      .all() as { target_id: string; action: string; after_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_id: journal.id, action: "create" });
    expect(JSON.parse(rows[0]?.after_json ?? "null")).toEqual(journal);
  });
});
