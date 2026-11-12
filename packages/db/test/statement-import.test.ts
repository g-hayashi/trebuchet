import { randomUUIDv7 } from "node:crypto";
import {
  commitStatementImport,
  commitStatementRows,
  listStatementBatches,
  previewStatementImport,
  type StatementRecord,
  type StatementRow,
  saveStatementAccount,
} from "@trebuchet/domain";
import type { StatementAccount, StatementBatch } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  type TempDataDir,
  testClock,
  testIds,
  useTempDataDir,
} from "../src/testing.ts";

// 006 T009。取込の永続化（往復、一意、INV-40・47 の取込の側）を実 DB で確かめる

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let store: DrizzleStatementStore;

const ids = testIds();
const clock = testClock();
const SHA = "a".repeat(64);

beforeEach(() => {
  tmp = useTempDataDir("statement-import");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const deps = () => ({ uow: createStatementUnitOfWork(db), ids, clock });

const account = (over: Partial<StatementAccount> = {}): StatementAccount => ({
  id: randomUUIDv7(),
  name: "サンプル銀行",
  usage: "business",
  kind: "bank",
  accountId: accountIdOf(masters, "普通預金"),
  subAccountId: null,
  createdAt: clock.now(),
  updatedAt: clock.now(),
  ...over,
});

const batch = (over: Partial<StatementBatch> = {}): StatementBatch => ({
  id: randomUUIDv7(),
  origin: "paste",
  sourceName: null,
  inputSha256: SHA,
  periodFrom: "2026-05-10",
  periodTo: "2026-05-11",
  countNew: 1,
  countExisting: 0,
  countUnreadable: 0,
  createdAt: clock.now(),
  ...over,
});

const record = (b: StatementBatch, a: StatementAccount, over: Partial<StatementRecord> = {}) => ({
  id: randomUUIDv7(),
  batchId: b.id,
  statementAccountId: a.id,
  stableKey: `${a.name}|2026-05-10|-1200|ショップ#|0`,
  externalId: null,
  date: "2026-05-10",
  amount: -1200,
  content: "ショップ001",
  normalizedContent: "ショップ#",
  categoryMajor: null,
  categoryMinor: null,
  memo: null,
  transferFlag: false,
  changedJson: null,
  changedAckAt: null,
  excludedAt: null,
  excludedReason: null,
  createdAt: clock.now(),
  ...over,
});

describe("DrizzleStatementStore（取込元の口座）", () => {
  it("追加・更新（ID で）・名前順の一覧。全項目が往復する", () => {
    const b = account({ name: "ばんく" });
    const a = account({ name: "あかうんと", usage: "private", kind: "card", accountId: null });
    store.upsertStatementAccount(b);
    store.upsertStatementAccount(a);
    expect(store.listStatementAccounts()).toEqual([a, b]);
    const updated = { ...b, usage: "mixed" as const, updatedAt: "2026-10-26T00:00:00.000Z" };
    store.upsertStatementAccount(updated);
    expect(store.listStatementAccounts()).toEqual([a, updated]);
    expect(count("statement_accounts")).toBe(2);
  });

  it("名前の重複は例外", () => {
    store.upsertStatementAccount(account());
    expect(() => store.upsertStatementAccount(account())).toThrow();
  });

  it("private が科目を持つ・それ以外が科目なしは CHECK で例外", () => {
    expect(() => store.upsertStatementAccount(account({ usage: "private", name: "x" }))).toThrow();
    expect(() =>
      store.upsertStatementAccount(account({ usage: "business", accountId: null, name: "y" })),
    ).toThrow();
  });
});

describe("DrizzleStatementStore（取込の回と明細）", () => {
  it("回は新しい順。明細は取り込んだ順。全項目が往復する", () => {
    const a = account();
    store.upsertStatementAccount(a);
    const b1 = batch({ createdAt: "2026-10-25T09:00:00.000Z" });
    const b2 = batch({ createdAt: "2026-10-26T09:00:00.000Z" });
    store.insertStatementBatch(b1);
    store.insertStatementBatch(b2);
    expect(store.listStatementBatches().map((x) => x.id)).toEqual([b2.id, b1.id]);
    expect(store.listStatementBatches()[1]).toEqual(b1);

    // 007: origin は file も、source_name（取込元の名前の写し）も往復する
    const b3 = batch({
      origin: "file",
      sourceName: "サンプル銀行",
      createdAt: "2026-10-27T09:00:00.000Z",
    });
    store.insertStatementBatch(b3);
    expect(store.listStatementBatches()[0]).toEqual(b3);

    const r1 = record(b1, a, {
      transferFlag: true,
      externalId: "ext-1",
      categoryMajor: "食費",
      categoryMinor: "食料品",
      memo: "メモ",
    });
    const r2 = record(b1, a, { stableKey: "k2", amount: 500 });
    store.insertStatements([r1, r2]);
    expect(store.listStatements()).toEqual([r1, r2]);
  });

  it("stable_key・external_id の重複は例外（INV-40）", () => {
    const a = account();
    store.upsertStatementAccount(a);
    const b = batch();
    store.insertStatementBatch(b);
    store.insertStatements([record(b, a, { externalId: "e1" })]);
    expect(() => store.insertStatements([record(b, a, { externalId: "e2" })])).toThrow();
    expect(() =>
      store.insertStatements([record(b, a, { stableKey: "k3", externalId: "e1" })]),
    ).toThrow();
  });

  it("markStatementChanged は changed_json を書き、changed_ack_at を NULL に戻す", () => {
    const a = account();
    store.upsertStatementAccount(a);
    const b = batch();
    store.insertStatementBatch(b);
    const r = record(b, a, { changedJson: '{"old":1}', changedAckAt: "2026-10-26T00:00:00.000Z" });
    store.insertStatements([r]);
    store.markStatementChanged(r.id, '{"new":2}');
    expect(store.listStatements()[0]).toMatchObject({
      changedJson: '{"new":2}',
      changedAckAt: null,
    });
    expect(() => store.markStatementChanged(randomUUIDv7(), "{}")).toThrow();
  });
});

describe("取込のユースケース（実 DB）", () => {
  const rows: StatementRow[] = [
    {
      accountName: "サンプル銀行",
      date: "2026-05-10",
      content: "ショップ001",
      amount: -1200,
      transferFlag: false,
    },
    {
      accountName: "サンプル銀行",
      date: "2026-05-10",
      content: "ショップ001",
      amount: -1200,
      transferFlag: false,
    },
    {
      accountName: "サンプル銀行",
      date: "2026-05-11",
      content: "売上入金",
      amount: 3000,
      transferFlag: true,
      memo: "メモ",
    },
  ];
  const text = [
    ["日付", "内容", "金額（円）", "保有金融機関", "メモ", "振替"].join("\t"),
    ["05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", "0"].join("\t"),
    ["05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", "0"].join("\t"),
    ["05/11(月)", "売上入金", "3,000", "サンプル銀行", "メモ", "1"].join("\t"),
  ].join("\n");
  const input = {
    text,
    origin: "paste" as const,
    year: 2026,
    mapping: {
      delimiter: "\t" as const,
      headerRow: 0,
      columns: { date: 0, content: 1, amount: 2, accountName: 3, memo: 4, transferFlag: 5 },
      amountSign: "inflow_positive" as const,
    },
    sha256: SHA,
  };

  const mapBank = () => {
    const r = saveStatementAccount(deps(), "サンプル銀行", {
      usage: "business",
      kind: "bank",
      accountId: accountIdOf(masters, "普通預金"),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };

  it("確定 → 再取込は新規 0 件。明細は DB に往復する（同じ内容の 2 行は 2 件）", () => {
    mapBank();
    const first = commitStatementImport(deps(), {
      ...input,
      expected: { inputSha256: SHA, countNew: 3 },
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.added).toBe(3);
    const stored = store.listStatements();
    expect(stored.map((s) => s.stableKey)).toEqual([
      "サンプル銀行|2026-05-10|-1200|ショップ#|0",
      "サンプル銀行|2026-05-10|-1200|ショップ#|1",
      "サンプル銀行|2026-05-11|3000|売上入金|0",
    ]);
    expect(stored[2]).toMatchObject({ transferFlag: true, memo: "メモ", amount: 3000 });

    const again = previewStatementImport(deps(), input);
    expect(again.ok && again.value.countNew).toBe(0);
    expect(count("statements")).toBe(3);
    expect(count("statement_batches")).toBe(1);
    expect(count("statement_audit_log")).toBe(2); // 口座の対応 + 取込の回
    const batches = listStatementBatches(deps());
    expect(batches.ok && batches.value[0]).toEqual(first.value.batch);
  });

  it("changed の行は changed_json を書く（external_id が同じで内容が違う）", () => {
    mapBank();
    const original: StatementRow = { ...(rows[0] as StatementRow), externalId: "ext-1" };
    commitStatementRows(deps(), {
      origin: "paste",
      rows: [original],
      unreadable: [],
      sha256: SHA,
      expected: { inputSha256: SHA, countNew: 1 },
    });
    const r = commitStatementRows(deps(), {
      origin: "paste",
      rows: [{ ...original, memo: "直した" }],
      unreadable: [],
      sha256: "b".repeat(64),
      expected: { inputSha256: "b".repeat(64), countNew: 0 },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.changed).toBe(1);
    expect(JSON.parse(store.listStatements()[0]?.changedJson ?? "{}")).toMatchObject({
      memo: "直した",
    });
  });

  it("途中で失敗すると、回も明細も監査も残らない（INV-47 の取込の側）", () => {
    mapBank();
    // 2 行目の明細の挿入を DB の側で失敗させる（回と 1 行目の後）
    db.$client.exec(
      `CREATE TRIGGER inject_failure BEFORE INSERT ON statements WHEN NEW.amount = 3000
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    const auditBefore = count("statement_audit_log");
    expect(() =>
      commitStatementImport(deps(), {
        ...input,
        expected: { inputSha256: SHA, countNew: 3 },
      }),
    ).toThrow("injected failure");
    expect(count("statement_batches")).toBe(0);
    expect(count("statements")).toBe(0);
    expect(count("statement_audit_log")).toBe(auditBefore);
  });

  it("未対応の口座では何も書かない", () => {
    const r = commitStatementImport(deps(), {
      ...input,
      expected: { inputSha256: SHA, countNew: 3 },
    });
    expect(r.ok).toBe(false);
    expect(count("statement_batches")).toBe(0);
    expect(count("statements")).toBe(0);
  });
});
