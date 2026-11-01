import { randomUUIDv7 } from "node:crypto";
import {
  commitAdjustment,
  createJournal,
  disposeFixedAsset,
  getAdjustmentProposals,
  saveFixedAsset,
  saveHomeUseAllocation,
  voidJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClosingUnitOfWork, DrizzleClosingStore } from "../src/closing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let closing: DrizzleClosingStore;
let uow: ReturnType<typeof createClosingUnitOfWork>;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-19T09:00:00.000Z" };

beforeEach(() => {
  tmp = useTempDataDir("closing-adjustment");
  db = openTenant(createTestEntity({ firstFiscalYear: 2025 }).id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  closing = new DrizzleClosingStore(db);
  uow = createClosingUnitOfWork(db);
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => accountIdOf(masters, name);

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const counts = () => ({
  journals: count("journals"),
  lines: count("journal_lines"),
  audit: count("audit_log"),
  refs: count("adjustment_journal_refs"),
});

/** 地代家賃 1,200,000 を払い、30% の按分を登録する */
function setup() {
  const paid = createJournal(
    { ledger, masters, ids, clock },
    {
      date: "2025-06-30",
      lines: [
        { side: "debit", accountId: accountId("地代家賃"), amount: 1_200_000 },
        { side: "credit", accountId: accountId("現金"), amount: 1_200_000 },
      ],
    },
  );
  if (!paid.ok) throw new Error(JSON.stringify(paid.error));
  const saved = saveHomeUseAllocation(
    { uow, ids, clock },
    { fiscalYear: 2025, accountId: accountId("地代家賃"), businessRatio: 3000, basis: "床面積" },
  );
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  return saved.value;
}

const commit = (sourceId: string, amount = 840_000) =>
  commitAdjustment(
    { uow, reports: ledger, ids, clock },
    { fiscalYear: 2025, kind: "home_use", sourceId, expected: { amount } },
  );

const proposals = () => {
  const r = getAdjustmentProposals({ masters, reports: ledger, closing }, { fiscalYear: 2025 });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("commitAdjustment（T019、実 DB、research R4）", () => {
  it("仕訳と adjustment_journal_refs を同じトランザクションで登録し、作り直した案はなくなる", () => {
    const allocation = setup();
    expect(proposals()).toHaveLength(1);
    const before = counts();
    const r = commit(allocation.id);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(counts()).toEqual({
      journals: before.journals + 1,
      lines: before.lines + 2,
      audit: before.audit + 1,
      refs: 1,
    });
    expect(closing.listAdjustmentRefs(2025)).toEqual([r.value.ref]);
    expect(ledger.getJournal(r.value.journal.id)?.lines.map((l) => l.amount)).toEqual([
      840_000, 840_000,
    ]);
    expect(proposals()).toEqual([]);
  });

  it("参照の登録が DB で失敗すると、仕訳・行・監査ログも残らない", () => {
    const allocation = setup();
    db.$client.exec(
      "CREATE TEMP TRIGGER fail_ref BEFORE INSERT ON adjustment_journal_refs BEGIN SELECT RAISE(ABORT, 'ref insert failed'); END",
    );
    const before = counts();
    expect(() => commit(allocation.id)).toThrow("ref insert failed");
    expect(counts()).toEqual(before);
    db.$client.exec("DROP TRIGGER fail_ref");
    // 失敗の後も同じ案をそのまま確定できる
    expect(commit(allocation.id).ok).toBe(true);
    expect(counts().refs).toBe(1);
  });

  it("金額が変わっていれば ADJUSTMENT_CHANGED、締め済みなら PERIOD_CLOSED で、どちらも何も書かない", () => {
    const allocation = setup();
    const before = counts();
    const changed = commit(allocation.id, 800_000);
    expect(!changed.ok && changed.error.code).toBe("ADJUSTMENT_CHANGED");
    expect(counts()).toEqual(before);

    const period = masters.getFiscalPeriodByYear(2025);
    if (period === undefined) throw new Error("会計期間がない");
    masters.updateFiscalPeriod({ ...period, status: "closed", closedAt: clock.now() });
    const closed = commit(allocation.id);
    expect(!closed.ok && closed.error.code).toBe("PERIOD_CLOSED");
    expect(counts()).toEqual(before);
  });
});

describe("減価償却の案の確定と変更の制限（009 T014、実 DB、INV-60、R12）", () => {
  /** 定額法 4 年（率 0.250）、2025-01-10 に取得・供用。各年 100,000 円 */
  function saveStraight() {
    const r = saveFixedAsset(
      { uow, ids, clock },
      {
        name: "サーバー",
        acquiredOn: "2025-01-10",
        acquisitionCost: 400_000,
        method: "straight_line",
        usefulLifeYears: 4,
        priorAccumulated: 0,
        businessRatio: 10000,
        assetAccountId: accountId("工具器具備品"),
      },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  }
  const commitDepreciation = (assetId: string) =>
    commitAdjustment(
      { uow, reports: ledger, ids, clock },
      { fiscalYear: 2025, kind: "depreciation", sourceId: assetId, expected: { amount: 100_000 } },
    );

  it("同じ資産・年度の 2 回目の確定は ADJUSTMENT_NOT_NEEDED で何も書かない。取り消すと案が戻り、また登録できる", () => {
    const asset = saveStraight();
    expect(proposals().map((p) => p.sourceId)).toEqual([asset.id]);
    const first = commitDepreciation(asset.id);
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(proposals()).toEqual([]);

    const before = counts();
    const again = commitDepreciation(asset.id);
    expect(!again.ok && again.error).toMatchObject({
      code: "ADJUSTMENT_NOT_NEEDED",
      details: { reason: "ALREADY_REGISTERED" },
    });
    expect(counts()).toEqual(before);

    const voided = voidJournal({ ledger, masters, ids, clock }, first.value.journal.id, {
      reason: "やり直し",
      version: first.value.journal.version,
    });
    expect(voided.ok).toBe(true);
    expect(proposals().map((p) => p.sourceId)).toEqual([asset.id]);
    expect(commitDepreciation(asset.id).ok).toBe(true);
    const active = closing
      .listAdjustmentRefsBySource({ assetId: asset.id })
      .filter((r) => ledger.getJournal(r.journalId)?.status === "active");
    expect(active).toHaveLength(1);
  });

  it("有効な償却の仕訳がある資産の計算に効く変更・除却は 409（同じトランザクションの仕訳の状態で判定）", () => {
    const asset = saveStraight();
    const committed = commitDepreciation(asset.id);
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const before = { ...counts(), audits: count("closing_audit_log") };

    const changed = saveFixedAsset(
      { uow, ids, clock },
      {
        id: asset.id,
        name: asset.name,
        acquiredOn: asset.acquiredOn,
        acquisitionCost: 300_000,
        method: "straight_line",
        usefulLifeYears: 4,
        priorAccumulated: 0,
        businessRatio: 10000,
        assetAccountId: asset.assetAccountId,
      },
    );
    expect(!changed.ok && changed.error).toMatchObject({
      code: "DEPRECIATION_JOURNAL_EXISTS",
      details: { years: [2025] },
    });
    const disposed = disposeFixedAsset(
      { uow, ids, clock },
      { id: asset.id, disposedOn: "2025-10-01", disposalKind: "sale", reason: "売却" },
    );
    expect(!disposed.ok && disposed.error.code).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect({ ...counts(), audits: count("closing_audit_log") }).toEqual(before);

    const later = disposeFixedAsset(
      { uow, ids, clock },
      { id: asset.id, disposedOn: "2026-03-31", disposalKind: "sale", reason: "売却" },
    );
    expect(later.ok && later.value).toMatchObject({
      disposedOn: "2026-03-31",
      disposalKind: "sale",
    });
  });
});
