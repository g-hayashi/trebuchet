import { randomUUIDv7 } from "node:crypto";
import {
  correctJournal,
  createJournal,
  createJournalFromReceipt,
  getReceipt,
  getTrialBalance,
  type JournalDraft,
  linkReceipt,
  listJournalReceipts,
  RECEIPT_REASON_AUTO_VOIDED,
  type ReceiptDeps,
  type ReceiptStore,
  type ReceiptUnitOfWork,
  type Result,
  type TenantTx,
  unlinkReceipt,
  voidJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createReceiptFileStore } from "../src/receipt-files.ts";
import { createReceiptUnitOfWork } from "../src/receipt-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  codeOf,
  createTestEntity,
  NOW,
  type TempDataDir,
  testClock,
  testIds,
  unwrap,
  useTempDataDir,
} from "../src/testing.ts";
import { receiptDb } from "./receipt-db-setup.ts";

// T021（INV-64）: 証憑と仕訳の結びつきを、実際の drizzleUnitOfWork・DB で確かめる。
// 訂正・取消との関係、付け替え、証憑から仕訳の登録の全部か無か、結びつきの操作が帳簿を変えないこと

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let raw: ReturnType<typeof receiptDb>;
let entityId: string;

const ids = testIds();
const clock = testClock();
const ledgerDeps = () => ({ ledger, masters, ids, clock });
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

beforeEach(() => {
  tmp = useTempDataDir("receipt-links");
  entityId = createTestEntity().id;
  db = openTenant(entityId);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  raw = receiptDb(db);
});
afterEach(() => tmp.cleanup());

const receiptDeps = (uow: ReceiptUnitOfWork = createReceiptUnitOfWork(db)): ReceiptDeps => ({
  uow,
  files: createReceiptFileStore(entityId),
  clock,
  ids,
  dateOf: (iso) => iso.slice(0, 10),
});

const draft = (date = "2026-10-20", amount = 1100): JournalDraft => ({
  date,
  memo: "合成の仕訳",
  lines: [
    { side: "debit", accountId: accountIdOf(masters, "消耗品費"), amount },
    { side: "credit", accountId: accountIdOf(masters, "普通預金"), amount },
  ],
});
const post = (date?: string, amount?: number) =>
  unwrap(createJournal(ledgerDeps(), draft(date, amount))).journal;
const voidIt = (id: string) => {
  const j = ledger.getJournal(id);
  if (j === undefined) throw new Error("仕訳がない");
  unwrap(voidJournal(ledgerDeps(), id, { reason: "取消", version: j.version }));
};

let shaSeq = 0;
/** 証憑（と版 1 のファイルの行）を足す。リンクの検査にファイルの中身は要らない */
const addReceipt = (over: Record<string, unknown> = {}) => {
  shaSeq += 1;
  const sha256 = shaSeq.toString(16).padStart(64, "0");
  return raw.addReceipt(
    { current_sha256: sha256, transaction_date: "2026-10-20", amount: 1100, ...over },
    { sha256 },
  ).id;
};

const count = (table: string) => Number(raw.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n);
const linkRows = (receiptId: string) =>
  raw.all(
    "SELECT journal_id, unlinked_at, unlink_reason FROM receipt_links WHERE receipt_id = ? ORDER BY rowid",
    receiptId,
  );
const activeJournalIds = (receiptId: string) =>
  linkRows(receiptId)
    .filter((l) => l.unlinked_at === null)
    .map((l) => l.journal_id);

/** 帳簿の状態（仕訳帳・試算表・監査の行）。結びつきの操作の前後で同じになる */
const ledgerState = () => ({
  journals: raw.all("SELECT * FROM journals ORDER BY journal_no"),
  lines: raw.all("SELECT * FROM journal_lines ORDER BY journal_id, line_no"),
  audit: raw.all("SELECT * FROM audit_log ORDER BY rowid"),
  trialBalance: unwrap(getTrialBalance({ masters, reports: ledger }, RANGE)),
});

describe("仕訳の訂正・取消との関係", () => {
  it("訂正の後も同じ journal_id で linked。取消の後は結びつきが残り journal_voided", () => {
    const receipt = addReceipt();
    const journal = post();
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: journal.id }));

    const corrected = unwrap(
      correctJournal(ledgerDeps(), journal.id, {
        ...draft("2026-10-22", 2200),
        reason: "訂正",
        version: journal.version,
      }),
    );
    expect(corrected.id).toBe(journal.id);
    expect(activeJournalIds(receipt)).toEqual([journal.id]);
    expect(unwrap(getReceipt(receiptDeps(), receipt))).toMatchObject({
      linkState: "linked",
      journal: { id: journal.id },
    });

    voidIt(journal.id);
    expect(activeJournalIds(receipt)).toEqual([journal.id]);
    expect(unwrap(getReceipt(receiptDeps(), receipt))).toMatchObject({
      linkState: "journal_voided",
      warnings: expect.arrayContaining([{ code: "JOURNAL_VOIDED" }]),
    });
    expect(unwrap(listJournalReceipts(receiptDeps(), journal.id)).map((r) => r.linkState)).toEqual([
      "journal_voided",
    ]);
  });
});

describe("結び直し・付け替え", () => {
  it("別の仕訳へ付け替えると、古い結びつきは理由つきで閉じ、新しいのが有効になる（行は消えない）", () => {
    const receipt = addReceipt();
    const a = post("2026-10-20");
    const b = post("2026-10-21");
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    expect(codeOf(linkReceipt(receiptDeps(), receipt, { journalId: b.id }))).toBe(
      "RECEIPT_ALREADY_LINKED",
    );
    unwrap(
      linkReceipt(receiptDeps(), receipt, { journalId: b.id, replace: true, reason: "付け替え" }),
    );
    expect(linkRows(receipt)).toEqual([
      { journal_id: a.id, unlinked_at: NOW, unlink_reason: "付け替え" },
      { journal_id: b.id, unlinked_at: null, unlink_reason: null },
    ]);
    expect(activeJournalIds(receipt)).toEqual([b.id]);
  });

  it("結びついた仕訳が取り消されていれば、別の仕訳へ結び直すと古い結びつきが自動で閉じる", () => {
    const receipt = addReceipt();
    const a = post("2026-10-20");
    const b = post("2026-10-21");
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    voidIt(a.id);
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: b.id }));
    expect(linkRows(receipt)).toEqual([
      { journal_id: a.id, unlinked_at: NOW, unlink_reason: RECEIPT_REASON_AUTO_VOIDED },
      { journal_id: b.id, unlinked_at: null, unlink_reason: null },
    ]);
  });

  it("解除すると結びつきは none。行は残り、結び直せる。履歴は追記だけで増える", () => {
    const receipt = addReceipt();
    const a = post();
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    unwrap(unlinkReceipt(receiptDeps(), receipt, { reason: "誤り" }));
    expect(unwrap(getReceipt(receiptDeps(), receipt)).linkState).toBe("none");
    expect(linkRows(receipt)).toHaveLength(1);
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    expect(linkRows(receipt)).toHaveLength(2);
    expect(activeJournalIds(receipt)).toEqual([a.id]);
    expect(
      raw
        .all(
          "SELECT target_type, action FROM receipt_audit_log WHERE receipt_id = ? ORDER BY rowid",
          receipt,
        )
        .map((e) => `${e.target_type}/${e.action}`),
    ).toEqual(["receipt_link/link", "receipt_link/unlink", "receipt_link/link"]);
  });

  it("1 件の仕訳に複数の証憑。仕訳側の合成（listJournalReceipts）に出る", () => {
    const r1 = addReceipt();
    const r2 = addReceipt();
    const a = post();
    unwrap(linkReceipt(receiptDeps(), r1, { journalId: a.id }));
    unwrap(linkReceipt(receiptDeps(), r2, { journalId: a.id }));
    expect(
      unwrap(listJournalReceipts(receiptDeps(), a.id))
        .map((r) => r.id)
        .sort(),
    ).toEqual([r1, r2].sort());
  });
});

describe("結びつきの操作は帳簿を変えない", () => {
  it("結びつけ・付け替え・解除の前後で、仕訳・仕訳の行・監査・試算表が同じ", () => {
    const receipt = addReceipt();
    const a = post("2026-10-20", 1100);
    const b = post("2026-10-21", 3300);
    const before = ledgerState();
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: b.id, replace: true, reason: "付替" }));
    unwrap(unlinkReceipt(receiptDeps(), receipt, { reason: "解除" }));
    expect(ledgerState()).toEqual(before);
  });
});

/** `method` の書き込みで例外を投げる UnitOfWork（途中の失敗の注入） */
function failingAt(method: keyof ReceiptStore): ReceiptUnitOfWork {
  const inner = createReceiptUnitOfWork(db);
  return {
    run<T>(fn: (tx: TenantTx<{ receipts: ReceiptStore }>) => Result<T>): Result<T> {
      return inner.run((tx) =>
        fn({
          ...tx,
          receipts: new Proxy(tx.receipts, {
            get(target, prop, receiver) {
              if (prop === method) {
                return () => {
                  throw new Error(`injected failure: ${method}`);
                };
              }
              const value: unknown = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        }),
      );
    },
  };
}

const counts = () => ({
  journals: count("journals"),
  lines: count("journal_lines"),
  audit: count("audit_log"),
  links: count("receipt_links"),
  receiptAudit: count("receipt_audit_log"),
});

describe("createJournalFromReceipt: 全部か無か", () => {
  it("成功すると仕訳・結びつき・履歴ができる", () => {
    const receipt = addReceipt();
    const result = unwrap(createJournalFromReceipt(receiptDeps(), receipt, { journal: draft() }));
    expect(result.receipt.linkState).toBe("linked");
    expect(activeJournalIds(receipt)).toEqual([result.journal.id]);
    expect(ledger.getJournal(result.journal.id)).toMatchObject({ status: "active" });
    expect(count("receipt_audit_log")).toBe(1);
  });

  it.each([
    ["結びつきの挿入", "insertLink" as const],
    ["結びつきの履歴の追記", "appendAudit" as const],
  ])("%s で失敗すると、仕訳・行・監査・結びつき・履歴が全部戻る", (_label, method) => {
    const receipt = addReceipt();
    const before = counts();
    const stateBefore = ledgerState();
    expect(() =>
      createJournalFromReceipt(receiptDeps(failingAt(method)), receipt, { journal: draft() }),
    ).toThrow("injected failure");
    expect(counts()).toEqual(before);
    expect(ledgerState()).toEqual(stateBefore);
  });

  it("仕訳の検査に落ちる（貸借不一致）と、何も残らない", () => {
    const receipt = addReceipt();
    const before = counts();
    const bad = draft();
    const first = bad.lines[0] as JournalDraft["lines"][number];
    const result = createJournalFromReceipt(receiptDeps(), receipt, {
      journal: { ...bad, lines: [{ ...first, amount: first.amount + 1 }, ...bad.lines.slice(1)] },
    });
    expect(result.ok).toBe(false);
    expect(counts()).toEqual(before);
  });

  it("有効な仕訳に結びついていれば RECEIPT_ALREADY_LINKED で、仕訳を作らない", () => {
    const receipt = addReceipt();
    const a = post();
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    const before = counts();
    expect(codeOf(createJournalFromReceipt(receiptDeps(), receipt, { journal: draft() }))).toBe(
      "RECEIPT_ALREADY_LINKED",
    );
    expect(counts()).toEqual(before);
  });

  it("結びついた仕訳が取り消されていれば、新しい仕訳に結び直し、古い結びつきを自動で閉じる", () => {
    const receipt = addReceipt();
    const a = post();
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    voidIt(a.id);
    const result = unwrap(createJournalFromReceipt(receiptDeps(), receipt, { journal: draft() }));
    expect(linkRows(receipt)).toEqual([
      { journal_id: a.id, unlinked_at: NOW, unlink_reason: RECEIPT_REASON_AUTO_VOIDED },
      { journal_id: result.journal.id, unlinked_at: null, unlink_reason: null },
    ]);
  });
});

describe("DB の部分 UNIQUE（INV-64 の最後の砦）", () => {
  it("有効な結びつきは証憑ごとに 1 件だけ。ユースケースを通せば複数になる経路がない", () => {
    const receipt = addReceipt();
    const a = post("2026-10-20");
    const b = post("2026-10-21");
    unwrap(linkReceipt(receiptDeps(), receipt, { journalId: a.id }));
    // ユースケースを迂回して 2 件目の有効な結びつきを入れようとすると DB が止める
    expect(() =>
      raw.insert("receipt_links", {
        id: randomUUIDv7(),
        receipt_id: receipt,
        journal_id: b.id,
        linked_at: NOW,
      }),
    ).toThrow();
    expect(activeJournalIds(receipt)).toEqual([a.id]);
  });
});
