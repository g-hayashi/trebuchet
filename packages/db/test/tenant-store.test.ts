import { randomUUIDv7 } from "node:crypto";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAll,
  InvalidEntityIdError,
  openRegistry,
  openTenant,
  tenantFile,
} from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("tenant-store");
});
afterEach(() => tmp.cleanup());

const tableNames = (db: ReturnType<typeof openTenant>) =>
  db.$client
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .all() as { name: string; sql: string }[];

describe("openTenant", () => {
  it("新しい entityId で DB ファイルが作られ、マイグレーションが適用される", () => {
    const id = randomUUIDv7();
    const db = openTenant(id);
    expect(existsSync(tenantFile(id))).toBe(true);
    const tables = tableNames(db);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["journals", "journal_lines", "audit_log", "tax_rates", "accounts"]),
    );
    // R2: 生成後の SQL に STRICT を付けている
    for (const t of tables) expect(t.sql).toMatch(/\)\s*STRICT$/);
    // 009: 新しい 3 表と作り直した 4 表（research R14）も STRICT
    for (const name of [
      "straight_line_rates",
      "deferred_assets",
      "deferred_amortizations",
      "fixed_assets",
      "adjustment_journal_refs",
      "tax_parameters",
      "closing_audit_log",
    ]) {
      expect(
        tables.map((t) => t.name),
        name,
      ).toContain(name);
    }
    // 010: 新しい 5 表（data-model §1）も存在する（STRICT は上の全表の検査）
    for (const name of [
      "receipts",
      "receipt_files",
      "receipt_links",
      "receipt_readings",
      "receipt_audit_log",
    ]) {
      expect(
        tables.map((t) => t.name),
        name,
      ).toContain(name);
    }
    const rates = db.$client.prepare("SELECT COUNT(*) AS n FROM tax_rates").get() as { n: number };
    expect(rates.n).toBe(4);
  });

  it("PRAGMA foreign_keys と WAL が有効", () => {
    const db = openTenant(randomUUIDv7());
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it.each(["../x", "..", "abc", "", "00000000-0000-0000-0000-00000000000g", "a/b"])(
    "不正な entityId %j は拒否される",
    (id) => {
      expect(() => openTenant(id)).toThrow(InvalidEntityIdError);
    },
  );

  it("同じ entityId は同じハンドルを返す", () => {
    const id = randomUUIDv7();
    expect(openTenant(id)).toBe(openTenant(id));
  });

  it("閉じて開き直しても、マイグレーションは二重に適用されない", () => {
    const id = randomUUIDv7();
    const first = openTenant(id);
    closeAll();
    const db = openTenant(id);
    expect(db).not.toBe(first);
    const rates = db.$client.prepare("SELECT COUNT(*) AS n FROM tax_rates").get() as { n: number };
    expect(rates.n).toBe(4);
  });
});

describe("openRegistry", () => {
  it("registry.sqlite を作り、entities テーブルを持つ", () => {
    const db = openRegistry();
    const names = tableNames(db as unknown as ReturnType<typeof openTenant>).map((t) => t.name);
    expect(names).toContain("entities");
    expect(openRegistry()).toBe(db);
  });
});
