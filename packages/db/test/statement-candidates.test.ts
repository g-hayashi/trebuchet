import { randomUUIDv7 } from "node:crypto";
import {
  buildCandidates,
  commitStatementRows,
  createJournal,
  getStatementSettings,
  type JournalDraft,
  listStatements,
  type StatementCandidateRecord,
  type StatementLinkRecord,
  type StatementRow,
  saveStatementAccount,
  saveStatementSettings,
} from "@trebuchet/domain";
import type { StatementAccount, StatementBatch } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  NOW,
  statementIdOf,
  type TempDataDir,
  testClock,
  testIds,
  unwrap,
  useTempDataDir,
} from "../src/testing.ts";

// 006 T014。候補・結びつき・設定の永続化と、候補の作成・一覧・設定を実 DB で確かめる

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let store: DrizzleStatementStore;

const ids = testIds();
const clock = testClock();

beforeEach(() => {
  tmp = useTempDataDir("statement-candidates");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const deps = () => ({ uow: createStatementUnitOfWork(db), ids, clock });

const bank = () => accountIdOf(masters, "普通預金");
const payable = () => accountIdOf(masters, "未払金");
const mapAccount = (name: string, over: Record<string, unknown> = {}) =>
  unwrap(
    saveStatementAccount(deps(), name, {
      usage: "business",
      kind: "bank",
      accountId: bank(),
      ...over,
    } as never),
  );

let shaSeq = 0;
const importRows = (rows: StatementRow[]) => {
  shaSeq += 1;
  const sha256 = shaSeq.toString(16).padStart(64, "0");
  unwrap(
    commitStatementRows(deps(), {
      origin: "paste",
      rows,
      unreadable: [],
      sha256,
      expected: { inputSha256: sha256, countNew: rows.length },
    }),
  );
};
const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  accountName: "サンプル銀行",
  date: "2026-10-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});
const rentDraft = (): JournalDraft => ({
  date: "2026-10-12",
  memo: "家賃",
  lines: [
    { side: "debit", accountId: accountIdOf(masters, "地代家賃"), amount: 80_000 },
    { side: "credit", accountId: bank(), amount: 80_000 },
  ],
});
const addJournal = () =>
  unwrap(createJournal({ ledger, masters, ids, clock }, rentDraft(), { source: "recurring" }))
    .journal;

const candidate = (
  statementId: string,
  over: Partial<StatementCandidateRecord> = {},
): StatementCandidateRecord => ({
  statementId,
  method: "rule",
  purpose: "business",
  confidence: 85,
  reason: "過去の同じ内容の明細 3 件と一致",
  draftJson: JSON.stringify({ date: "2026-10-10", lines: [] }),
  ruleId: null,
  model: null,
  createdAt: NOW,
  ...over,
});

/** 回・口座・明細を 1 件ずつ作って明細の ID を返す */
function seedStatement(): { statementId: string; account: StatementAccount } {
  const account = mapAccount("サンプル銀行").account;
  const b: StatementBatch = {
    id: randomUUIDv7(),
    origin: "paste",
    sourceName: null,
    inputSha256: "a".repeat(64),
    periodFrom: "2026-10-10",
    periodTo: "2026-10-10",
    countNew: 1,
    countExisting: 0,
    countUnreadable: 0,
    createdAt: NOW,
  };
  store.insertStatementBatch(b);
  const statementId = randomUUIDv7();
  store.insertStatements([
    {
      id: statementId,
      batchId: b.id,
      statementAccountId: account.id,
      stableKey: "k1",
      externalId: null,
      date: "2026-10-10",
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
      createdAt: NOW,
    },
  ]);
  return { statementId, account };
}

describe("DrizzleStatementStore（候補）", () => {
  it("追加・置き換え（同じ明細）・削除。全項目が往復する", () => {
    const { statementId } = seedStatement();
    const c = candidate(statementId, { model: "m" });
    store.upsertStatementCandidate(c);
    expect(store.listStatementCandidates()).toEqual([c]);
    const replaced = candidate(statementId, { method: "local_ai", confidence: 55, model: "fm" });
    store.upsertStatementCandidate(replaced);
    expect(store.listStatementCandidates()).toEqual([replaced]);
    expect(count("statement_candidates")).toBe(1);
    store.deleteStatementCandidate(statementId);
    expect(store.listStatementCandidates()).toEqual([]);
  });

  it("none の形（purpose・confidence・draft は NULL）と、none 以外の形は CHECK で守られる", () => {
    const { statementId } = seedStatement();
    store.upsertStatementCandidate(
      candidate(statementId, { method: "none", purpose: null, confidence: null, draftJson: null }),
    );
    expect(() =>
      store.upsertStatementCandidate(candidate(statementId, { method: "none" })),
    ).toThrow();
    expect(() =>
      store.upsertStatementCandidate(candidate(statementId, { purpose: null })),
    ).toThrow();
    expect(() =>
      store.upsertStatementCandidate(candidate(statementId, { confidence: 101 })),
    ).toThrow();
  });

  it("存在しない明細への候補は例外（FK）", () => {
    seedStatement();
    expect(() => store.upsertStatementCandidate(candidate("no-such"))).toThrow();
  });
});

describe("DrizzleStatementStore（結びつき）", () => {
  const link = (
    statementId: string,
    journalId: string,
    journalLineId: string,
    over: Partial<StatementLinkRecord> = {},
  ): StatementLinkRecord => ({
    id: randomUUIDv7(),
    statementId,
    journalId,
    journalLineId,
    kind: "matched",
    createdAt: NOW,
    revokedAt: null,
    revokedReason: null,
    ...over,
  });

  it("往復し、有効な結びつきは明細ごと・行ごとに高々 1 件（INV-43）。失効すれば結び直せる", () => {
    const { statementId } = seedStatement();
    const j = addJournal();
    const line = j.lines[1];
    if (line === undefined) throw new Error("行がない");
    const l1 = link(statementId, j.id, line.id);
    store.insertStatementLink(l1);
    expect(store.listStatementLinks()).toEqual([l1]);
    expect(() =>
      store.insertStatementLink(link(statementId, j.id, j.lines[0]?.id ?? "")),
    ).toThrow();
    const revoked = { ...l1, revokedAt: NOW, revokedReason: "やり直し" };
    db.$client
      .prepare("UPDATE statement_links SET revoked_at = ?, revoked_reason = ? WHERE id = ?")
      .run(NOW, "やり直し", l1.id);
    expect(store.listStatementLinks()).toEqual([revoked]);
    store.insertStatementLink(link(statementId, j.id, line.id));
    expect(count("statement_links")).toBe(2);
  });
});

describe("DrizzleStatementStore（設定）", () => {
  it("なければ undefined。保存して読み直せ、1 行だけ", () => {
    expect(store.getStatementSettings()).toBeUndefined();
    const s = { bulkThreshold: 90, externalThreshold: 50, updatedAt: NOW };
    store.saveStatementSettings(s);
    expect(store.getStatementSettings()).toEqual(s);
    const s2 = { ...s, bulkThreshold: 70, updatedAt: "2026-10-26T00:00:00.000Z" };
    store.saveStatementSettings(s2);
    expect(store.getStatementSettings()).toEqual(s2);
    expect(count("statement_settings")).toBe(1);
  });

  it("範囲外は CHECK で例外", () => {
    expect(() =>
      store.saveStatementSettings({ bulkThreshold: 101, externalThreshold: 60, updatedAt: NOW }),
    ).toThrow();
    expect(() =>
      store.saveStatementSettings({ bulkThreshold: 80, externalThreshold: -1, updatedAt: NOW }),
    ).toThrow();
  });
});

describe("候補の作成・一覧・設定（実 DB の通し）", () => {
  it("既存の仕訳との照合と振替の対で候補ができ、一覧に出る。仕訳の取消で未処理に戻る", () => {
    mapAccount("サンプル銀行");
    mapAccount("テストカードA", { kind: "card", usage: "mixed", accountId: payable() });
    const j = addJournal();
    importRows([
      row({ content: "家賃", amount: -80_000, date: "2026-10-12" }),
      row({ content: "カード引落", amount: -30_000, transferFlag: true, date: "2026-10-20" }),
      row({
        accountName: "テストカードA",
        content: "お支払い",
        amount: 30_000,
        transferFlag: true,
        date: "2026-10-21",
      }),
      row({ content: "ショップ001", amount: -500, date: "2026-10-22" }),
    ]);
    const built = unwrap(buildCandidates(deps()));
    expect(built.built).toBe(4);
    expect(built.needsAi).toEqual([statementIdOf(store, "ショップ001")]);
    expect(count("statement_candidates")).toBe(4);

    const views = unwrap(listStatements(deps()));
    const by = (c: string) => views.find((v) => v.content === c);
    expect(by("家賃")?.candidate).toMatchObject({
      method: "match",
      match: { journalId: j.id, lineId: j.lines[1]?.id },
    });
    expect(by("カード引落")?.candidate?.method).toBe("transfer");
    expect(by("お支払い")?.candidate?.draft?.lines).toHaveLength(2);
    expect(by("ショップ001")?.candidate?.method).toBe("none");
    expect(views.every((v) => v.status === "unprocessed")).toBe(true);

    // 結びつけると registered、仕訳を取り消すと unprocessed（INV-44）
    store.insertStatementLink({
      id: randomUUIDv7(),
      statementId: statementIdOf(store, "家賃"),
      journalId: j.id,
      journalLineId: j.lines[1]?.id ?? "",
      kind: "matched",
      createdAt: NOW,
      revokedAt: null,
      revokedReason: null,
    });
    expect(unwrap(listStatements(deps(), { status: "registered" })).map((v) => v.content)).toEqual([
      "家賃",
    ]);
    ledger.voidJournal(j.id, j.version, NOW);
    expect(unwrap(listStatements(deps(), { status: "registered" }))).toEqual([]);
  });

  it("科目の対応を変えると候補を作り直す（rebuilt）", () => {
    mapAccount("サンプル銀行");
    addJournal();
    importRows([row({ content: "家賃", amount: -80_000, date: "2026-10-12" })]);
    unwrap(buildCandidates(deps()));
    expect(store.listStatementCandidates()[0]?.method).toBe("match");
    const saved = mapAccount("サンプル銀行", { accountId: accountIdOf(masters, "現金") });
    expect(saved.rebuilt).toBe(1);
    expect(store.listStatementCandidates()[0]?.method).toBe("none");
  });

  it("設定の往復と監査", () => {
    expect(unwrap(getStatementSettings(deps()))).toMatchObject({
      bulkThreshold: 80,
      externalThreshold: 60,
    });
    unwrap(saveStatementSettings(deps(), { bulkThreshold: 95, externalThreshold: 40 }));
    expect(unwrap(getStatementSettings(deps()))).toMatchObject({
      bulkThreshold: 95,
      externalThreshold: 40,
    });
    const logged = db.$client
      .prepare("SELECT target_type, action FROM statement_audit_log WHERE target_type = ?")
      .all("statement_settings");
    expect(logged).toEqual([{ target_type: "statement_settings", action: "create" }]);
  });
});
