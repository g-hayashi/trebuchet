import { randomUUIDv7 } from "node:crypto";
import type { StatementAuditEntry } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { createTestEntity, NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 data-model §6（StatementUnitOfWork）、INV-47。監査の追記と、run の中のストアの共有を実 DB で確かめる。
// 例外・err・ok の巻き戻しは unit-of-work.test.ts の全機能共通の性質テストで確かめる

let tmp: TempDataDir;
let db: TenantDb;

beforeEach(() => {
  tmp = useTempDataDir("statement-uow");
  db = openTenant(createTestEntity().id);
});
afterEach(() => tmp.cleanup());

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

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
