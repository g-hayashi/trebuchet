import { randomUUIDv7 } from "node:crypto";
import {
  commitAdjustment,
  createEntity,
  createJournal,
  getAdjustmentProposals,
  saveHomeUseAllocation,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClosingUnitOfWork, DrizzleClosingStore } from "../src/closing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

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
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(created.error.message);
  db = openTenant(created.value.id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  closing = new DrizzleClosingStore(db);
  uow = createClosingUnitOfWork(db);
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => {
  const a = masters.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a.id;
};

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
