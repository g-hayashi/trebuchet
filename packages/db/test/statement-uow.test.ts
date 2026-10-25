import { randomUUIDv7 } from "node:crypto";
import {
  createJournal,
  domainError,
  err,
  type JournalDraft,
  type LedgerRepository,
  type MasterRepository,
  ok,
  type StatementAuditEntry,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 data-model §6（StatementUnitOfWork）、INV-47。巻き戻しと監査の追記を実 DB で確かめる

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-25T09:00:00.000Z" };
const NOW = clock.now();

beforeEach(() => {
  tmp = useTempDataDir("statement-uow");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const draft = (amount = 1_000): JournalDraft => ({
  date: "2026-10-31",
  lines: [
    { side: "debit", accountId: accountIdOf(masters, "消耗品費"), amount },
    { side: "credit", accountId: accountIdOf(masters, "現金"), amount },
  ],
});

/** 与えた帳簿（トランザクション内のものでもよい）に出所 statement の仕訳を登録する */
function post(deps: { ledger: LedgerRepository; masters: MasterRepository }): string {
  const r = createJournal({ ...deps, ids, clock }, draft(), { source: "statement" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.journal.id;
}

const audit = (over: Partial<StatementAuditEntry> = {}): StatementAuditEntry => ({
  id: randomUUIDv7(),
  occurredAt: NOW,
  targetType: "statement",
  targetId: randomUUIDv7(),
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
  ...over,
});

describe("createStatementUnitOfWork", () => {
  it("中で仕訳を作った後に例外を投げると、仕訳・行・記録がすべて残らない", () => {
    const uow = createStatementUnitOfWork(db);
    const before = {
      journals: count("journals"),
      lines: count("journal_lines"),
      audit: count("audit_log"),
    };
    expect(() =>
      uow.run(({ ledger, masters: m, statements }) => {
        post({ ledger, masters: m });
        statements.appendStatementAudit(audit());
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect({
      journals: count("journals"),
      lines: count("journal_lines"),
      audit: count("audit_log"),
    }).toEqual(before);
    expect(count("statement_audit_log")).toBe(0);
  });

  it("仕訳を作った後に err を返すと、仕訳も記録も残らず、同じ err を返す", () => {
    const uow = createStatementUnitOfWork(db);
    const failure = domainError("VALIDATION", "中止");
    const r = uow.run(({ ledger, masters: m, statements }) => {
      post({ ledger, masters: m });
      statements.appendStatementAudit(audit());
      return err(failure);
    });
    expect(r).toEqual(err(failure));
    expect(count("journals")).toBe(0);
    expect(count("audit_log")).toBe(0);
    expect(count("statement_audit_log")).toBe(0);
  });

  it("ok なら仕訳と記録が残る", () => {
    const uow = createStatementUnitOfWork(db);
    uow.run(({ ledger, masters: m, statements }) => {
      post({ ledger, masters: m });
      statements.appendStatementAudit(audit());
      return ok(null);
    });
    expect(count("journals")).toBe(1);
    expect(count("statement_audit_log")).toBe(1);
  });

  it("run の中のストアは同じトランザクション（外のストアにも失敗後は何も見えない）", () => {
    const uow = createStatementUnitOfWork(db);
    const outside = new DrizzleStatementStore(db);
    expect(() =>
      uow.run(({ statements }) => {
        statements.appendStatementAudit(audit());
        throw new Error("失敗");
      }),
    ).toThrow("失敗");
    outside.appendStatementAudit(audit());
    expect(count("statement_audit_log")).toBe(1);
  });
});

describe("appendStatementAudit", () => {
  it("statement_audit_log に追記され、全項目が往復する", () => {
    const a = audit({
      reason: "理由",
      beforeJson: '{"a":1}',
      afterJson: '{"a":2}',
      action: "exclude",
      targetType: "statement",
    });
    const b = audit({ targetType: "inference_rule", action: "pause" });
    const store = new DrizzleStatementStore(db);
    store.appendStatementAudit(a);
    store.appendStatementAudit(b);
    const rows = db.$client
      .prepare(
        `SELECT id, occurred_at AS occurredAt, target_type AS targetType, target_id AS targetId, action,
                reason, before_json AS beforeJson, after_json AS afterJson
         FROM statement_audit_log ORDER BY rowid`,
      )
      .all();
    expect(rows).toEqual([a, b]);
  });

  it("ledger の audit_log とは別の表に書く", () => {
    new DrizzleStatementStore(db).appendStatementAudit(audit());
    expect(count("audit_log")).toBe(0);
  });
});
