import { randomUUIDv7 } from "node:crypto";
import { ok } from "@trebuchet/domain";
import type { StatementSource } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStatementUnitOfWork, DrizzleStatementStore } from "../src/statement-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { createTestEntity, NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 007 T004。取込元（statement_sources）の永続化を実 DB で確かめる（data-model §1.1）

let tmp: TempDataDir;
let db: TenantDb;
let store: DrizzleStatementStore;

beforeEach(() => {
  tmp = useTempDataDir("statement-sources");
  db = openTenant(createTestEntity().id);
  store = new DrizzleStatementStore(db);
});
afterEach(() => tmp.cleanup());

const source = (over: Partial<StatementSource> = {}): StatementSource => ({
  id: randomUUIDv7(),
  name: "サンプル銀行",
  fixedAccountName: "サンプル銀行",
  mapping: {
    delimiter: ",",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2 },
    amountSign: "inflow_positive",
  },
  header: ["日付", "内容", "金額"],
  lastUsedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe("DrizzleStatementStore（取込元）", () => {
  it("追加した全項目が往復する（mapping は検証して戻す。header は配列か null）", () => {
    const a = source();
    const b = source({
      name: "まとめ",
      fixedAccountName: null,
      header: null,
      mapping: {
        delimiter: "\t",
        headerRow: null,
        columns: { date: 0, content: 1, outflow: 2, inflow: 3, accountName: 4 },
      },
    });
    store.upsertStatementSource(a);
    store.upsertStatementSource(b);
    expect(store.listStatementSources()).toEqual([b, a]); // 名前の順（文字コード順。ひらがなはカタカナより前）
  });

  it("id が保存済みなら更新する（名前・対応・最終使用日時）", () => {
    const a = source();
    store.upsertStatementSource(a);
    const changed = source({
      id: a.id,
      name: "改名",
      lastUsedAt: "2026-10-27T09:00:00.000Z",
      updatedAt: "2026-10-27T09:00:00.000Z",
      createdAt: "2030-01-01T00:00:00.000Z", // created_at は書き換わらない
    });
    store.upsertStatementSource(changed);
    expect(store.listStatementSources()).toEqual([{ ...changed, createdAt: a.createdAt }]);
  });

  it("名前の重複は例外（別の id）", () => {
    store.upsertStatementSource(source());
    expect(() => store.upsertStatementSource(source())).toThrow(/UNIQUE/);
    expect(store.listStatementSources()).toHaveLength(1);
  });

  it("削除できる。ない id は例外", () => {
    const a = source();
    store.upsertStatementSource(a);
    store.deleteStatementSource(a.id);
    expect(store.listStatementSources()).toEqual([]);
    expect(() => store.deleteStatementSource(a.id)).toThrow(/not found/);
  });

  it("取込元を消しても、取込の回の source_name は残る", () => {
    const a = source();
    store.upsertStatementSource(a);
    store.insertStatementBatch({
      id: randomUUIDv7(),
      origin: "file",
      sourceName: a.name,
      inputSha256: "a".repeat(64),
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      countNew: 0,
      countExisting: 0,
      countUnreadable: 0,
      createdAt: NOW,
    });
    store.deleteStatementSource(a.id);
    expect(store.listStatementBatches()[0]?.sourceName).toBe(a.name);
  });

  it("操作の記録（statement_source の create・update・delete）を追記できる", () => {
    const a = source();
    const uow = createStatementUnitOfWork(db);
    const r = uow.run(({ statements }) => {
      statements.upsertStatementSource(a);
      for (const action of ["create", "update", "delete"] as const) {
        statements.appendStatementAudit({
          id: randomUUIDv7(),
          occurredAt: NOW,
          targetType: "statement_source",
          targetId: a.id,
          action,
          reason: null,
          beforeJson: null,
          afterJson: null,
        });
      }
      return ok(undefined);
    });
    expect(r.ok).toBe(true);
    const n = (
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM statement_audit_log WHERE target_type = 'statement_source'",
        )
        .get() as { n: number }
    ).n;
    expect(n).toBe(3);
  });
});
