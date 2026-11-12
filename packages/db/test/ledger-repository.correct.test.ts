import { randomUUIDv7 } from "node:crypto";
import {
  type AuditEntry,
  correctJournal,
  createJournal,
  type JournalDraft,
  type JournalReplacement,
  type LedgerRepository,
  type NewJournal,
  RepositoryConflictError,
  validateJournal,
  voidJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  type TempDataDir,
  testClock,
  testIds,
  useTempDataDir,
} from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;

const ids = testIds();
const clock = testClock();
const LATER = "2026-11-01T10:00:00.000Z";

beforeEach(() => {
  tmp = useTempDataDir("ledger-correct");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
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

function validated(draft: JournalDraft) {
  const valid = validateJournal(draft, context());
  if (!valid.ok) throw new Error(JSON.stringify(valid.error));
  return valid.value;
}

function newJournal(draft: JournalDraft, journalNo: number): NewJournal {
  const valid = validated(draft);
  return {
    ...valid,
    id: randomUUIDv7(),
    journalNo,
    createdAt: clock.now(),
    lines: valid.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
  };
}

function replacement(draft: JournalDraft): JournalReplacement {
  const valid = validated(draft);
  return { ...valid, lines: valid.lines.map((l) => ({ ...l, id: randomUUIDv7() })) };
}

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let tagA: string;
let tagB: string;

/** 3 行・タグつきの仕訳 */
function insertTagged() {
  tagA = randomUUIDv7();
  tagB = randomUUIDv7();
  masters.insertTag({ id: tagA, name: "定期" });
  masters.insertTag({ id: tagB, name: "源泉" });
  return ledger.insertJournal(
    newJournal(
      {
        date: "2026-10-31",
        memo: "10月分",
        lines: [
          { side: "debit", accountId: accountId("普通預金"), amount: 487_037, tagIds: [tagA] },
          { side: "debit", accountId: accountId("事業主貸"), amount: 7963, tagIds: [tagA, tagB] },
          { side: "credit", accountId: accountId("売掛金"), amount: 495_000 },
        ],
      },
      1,
    ),
  );
}

const audit = (targetId: string, action: AuditEntry["action"]): AuditEntry => ({
  id: randomUUIDv7(),
  occurredAt: LATER,
  targetType: "journal",
  targetId,
  action,
  reason: "テスト",
  beforeJson: "{}",
  afterJson: "{}",
});

describe("DrizzleLedgerRepository の訂正・取消（US3）", () => {
  it("replaceJournal は行とタグを全件置き換え、version を +1 する。仕訳番号・作成日時は変えない", () => {
    const original = insertTagged();
    const next = replacement({
      date: "2026-11-01",
      memo: "訂正後",
      lines: [
        { side: "debit", accountId: accountId("普通預金"), amount: 495_000, tagIds: [tagB] },
        { side: "credit", accountId: accountId("売掛金"), amount: 495_000 },
      ],
    });
    const saved = ledger.replaceJournal(original.id, next, 1, LATER);
    expect(saved).toMatchObject({
      id: original.id,
      journalNo: 1,
      date: "2026-11-01",
      memo: "訂正後",
      status: "active",
      version: 2,
      createdAt: original.createdAt,
      updatedAt: LATER,
    });
    expect(saved.lines.map((l) => [l.lineNo, l.amount, l.tagIds])).toEqual([
      [1, 495_000, [tagB]],
      [2, 495_000, []],
    ]);
    expect(ledger.getJournal(original.id)).toEqual(saved);
    expect(count("journal_lines")).toBe(2);
    expect(count("journal_line_tags")).toBe(1);
  });

  it("expectedVersion が一致しなければ RepositoryConflictError で、何も変えない", () => {
    const original = insertTagged();
    const next = replacement({
      date: "2026-11-01",
      lines: [
        { side: "debit", accountId: accountId("現金"), amount: 1 },
        { side: "credit", accountId: accountId("売上高"), amount: 1 },
      ],
    });
    expect(() => ledger.replaceJournal(original.id, next, 2, LATER)).toThrow(
      RepositoryConflictError,
    );
    expect(() => ledger.voidJournal(original.id, 2, LATER)).toThrow(RepositoryConflictError);
    expect(ledger.getJournal(original.id)).toEqual(original);
    expect(count("journal_line_tags")).toBe(3);
  });

  it("voidJournal は status を voided にして version を +1 し、行とタグは残す", () => {
    const original = insertTagged();
    const voided = ledger.voidJournal(original.id, 1, LATER);
    expect(voided).toEqual({ ...original, status: "voided", version: 2, updatedAt: LATER });
    expect(ledger.getJournal(original.id)).toEqual(voided);
    expect(count("journal_lines")).toBe(3);
    expect(count("journal_line_tags")).toBe(3);
  });

  it("仕訳の更新と audit_log の追記は同じトランザクション（途中で例外なら両方とも残らない）", () => {
    const original = insertTagged();
    for (const op of [
      (tx: LedgerRepository) =>
        tx.replaceJournal(
          original.id,
          replacement({
            date: "2026-11-01",
            lines: [
              { side: "debit", accountId: accountId("現金"), amount: 1 },
              { side: "credit", accountId: accountId("売上高"), amount: 1 },
            ],
          }),
          1,
          LATER,
        ),
      (tx: LedgerRepository) => tx.voidJournal(original.id, 1, LATER),
    ]) {
      expect(() =>
        ledger.transaction((tx) => {
          op(tx);
          tx.appendAudit(audit(original.id, "correct"));
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(ledger.getJournal(original.id)).toEqual(original);
      expect(count("audit_log")).toBe(0);
      expect(count("journal_line_tags")).toBe(3);
    }
  });

  it("journalHistory は仕訳の audit_log を記録の順に返す。correctingJournalsOf は訂正仕訳を仕訳番号の順に返す", () => {
    const deps = { ledger, masters, ids, clock };
    const sale = (amount: number, date = "2026-10-31"): JournalDraft => ({
      date,
      lines: [
        { side: "debit", accountId: accountId("売掛金"), amount },
        { side: "credit", accountId: accountId("売上高"), amount },
      ],
    });
    const created = createJournal(deps, sale(495_000));
    if (!created.ok) throw new Error(created.error.message);
    const { journal } = created.value;
    const corrected = correctJournal(deps, journal.id, {
      ...sale(500_000),
      reason: "金額の誤り",
      version: 1,
    });
    if (!corrected.ok) throw new Error(corrected.error.message);
    const voided = voidJournal(deps, journal.id, { reason: "二重登録", version: 2 });
    if (!voided.ok) throw new Error(voided.error.message);

    const history = ledger.journalHistory(journal.id);
    expect(history.map((h) => [h.action, h.reason])).toEqual([
      ["create", null],
      ["correct", "金額の誤り"],
      ["void", "二重登録"],
    ]);
    expect(JSON.parse(history[1]?.beforeJson ?? "null")).toEqual(journal);
    expect(JSON.parse(history[2]?.beforeJson ?? "null")).toEqual(corrected.value);
    expect(ledger.journalHistory(randomUUIDv7())).toEqual([]);

    db.$client.prepare("UPDATE fiscal_periods SET status = 'closed'").run();
    const nextYear = db.$client.prepare(
      "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES (?, 2027, '2027-01-01', '2027-12-31', 'open')",
    );
    nextYear.run(randomUUIDv7());
    const fixes = [5000, 7000].map((amount) => {
      const r = createJournal(deps, {
        ...sale(amount, "2027-01-10"),
        correctsJournalId: journal.id,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value.journal;
    });
    expect(ledger.correctingJournalsOf(journal.id)).toEqual(fixes);
    expect(ledger.correctingJournalsOf(fixes[0]?.id ?? "")).toEqual([]);
  });
});
