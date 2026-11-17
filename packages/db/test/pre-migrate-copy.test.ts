import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database, drizzleOf } from "../src/driver.ts";
import {
  authFile,
  closeAll,
  type DbKeyScope,
  openAuth,
  openEncryptedSqlite,
  openRegistry,
  openTenant,
  PRE_MIGRATE_KEEP,
  preMigrateDir,
  registryFile,
  removeTenantData,
  tenantFile,
} from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { migrationCount, migrationsUpTo } from "./migration-fixtures.ts";

/** 起動時のマイグレーションの前の自動退避（`<データ場所>/pre-migrate/`） */

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("pre-migrate");
});
afterEach(() => tmp.cleanup());

const SQLITE_MAGIC = "SQLite format 3";

/**
 * 古い版（先頭 count 件だけ当てた）の DB を file に作る（WAL）。scope が null なら暗号化しない（auth）。
 * keepOpen なら、fill の後に閉じずに返す（WAL に残った書き込みが写しに入るかを確かめる）
 */
function createOldDb(
  file: string,
  scope: DbKeyScope | null,
  kind: "registry" | "tenant" | "auth",
  count: number,
  fill: (db: Database.Database) => void = () => {},
  keepOpen = false,
): Database.Database | undefined {
  mkdirSync(dirname(file), { recursive: true });
  const db = scope === null ? new Database(file) : openEncryptedSqlite(file, scope);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(drizzleOf(db, {}), { migrationsFolder: migrationsUpTo(tmp.dir, kind, count) });
  if (keepOpen) {
    db.pragma("wal_autocheckpoint = 0");
    fill(db);
    return db;
  }
  fill(db);
  db.close();
  return undefined;
}

const copies = () => (existsSync(preMigrateDir()) ? readdirSync(preMigrateDir()).sort() : []);

function readCopy<T>(name: string, scope: DbKeyScope | null, fn: (db: Database.Database) => T): T {
  const file = join(preMigrateDir(), name);
  const db =
    scope === null
      ? new Database(file, { readonly: true, fileMustExist: true })
      : openEncryptedSqlite(file, scope, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const applied = (db: Database.Database) =>
  (db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;

const insertEntity = (id: string) => (db: Database.Database) => {
  db.prepare(
    "INSERT INTO entities (id, name, kind, db_file, created_at) VALUES (?, '移行前の事業', 'individual', ?, '2026-01-01T00:00:00.000Z')",
  ).run(id, `tenants/${id}.sqlite`);
};

const STAMPED = /-\d{8}-\d{6}(-\d+)?\.sqlite$/;

describe("起動時のマイグレーションの前の写し", () => {
  it("registry: 未適用があれば写しを取り、写しは移行前の版の内容で暗号化されている（WAL の中身も含む）", () => {
    const oldCount = migrationCount("registry") - 2;
    const entityId = randomUUIDv7().toLowerCase();
    const writer = createOldDb(
      registryFile(),
      "registry",
      "registry",
      oldCount,
      insertEntity(entityId),
      true,
    );
    try {
      openRegistry();
    } finally {
      writer?.close();
    }
    const names = copies();
    expect(names).toHaveLength(1);
    const [name] = names;
    if (name === undefined) return;
    expect(name).toMatch(/^registry-\d{8}-\d{6}\.sqlite$/);
    expect(readFileSync(join(preMigrateDir(), name)).subarray(0, 15).toString("latin1")).not.toBe(
      SQLITE_MAGIC,
    );
    readCopy(name, "registry", (db) => {
      expect(applied(db)).toBe(oldCount);
      expect(db.prepare("SELECT id FROM entities").all()).toEqual([{ id: entityId }]);
    });
    // 本体は今の版まで当たり、行は残る
    const reg = openRegistry().$client;
    expect(applied(reg)).toBe(migrationCount("registry"));
    expect(reg.prepare("SELECT id, status FROM entities").all()).toEqual([
      { id: entityId, status: "active" },
    ]);
  });

  it("事業体: 写しの名前に事業体の ID が入り、写しは移行前の版の内容", () => {
    const entityId = randomUUIDv7().toLowerCase();
    const oldCount = migrationCount("tenant") - 3;
    createOldDb(tenantFile(entityId), { tenant: entityId }, "tenant", oldCount, (db) => {
      db.prepare(
        "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES ('p1', 2026, '2026-01-01', '2026-12-31', 'open')",
      ).run();
    });
    openTenant(entityId);
    const [name, ...rest] = copies();
    expect(rest).toEqual([]);
    expect(name).toMatch(new RegExp(`^tenant-${entityId}-\\d{8}-\\d{6}\\.sqlite$`));
    if (name === undefined) return;
    readCopy(name, { tenant: entityId }, (db) => {
      expect(applied(db)).toBe(oldCount);
      expect(db.prepare("SELECT id FROM fiscal_periods").all()).toEqual([{ id: "p1" }]);
    });
    expect(applied(openTenant(entityId).$client)).toBe(migrationCount("tenant"));
  });

  it("auth（暗号化しない）: 未適用があれば写しを取る", () => {
    const oldCount = migrationCount("auth") - 1;
    createOldDb(authFile(), null, "auth", oldCount);
    openAuth();
    const [name, ...rest] = copies();
    expect(rest).toEqual([]);
    expect(name).toMatch(/^auth-\d{8}-\d{6}\.sqlite$/);
    if (name === undefined) return;
    readCopy(name, null, (db) => expect(applied(db)).toBe(oldCount));
  });

  it("新しく作った DB と、未適用のない既存の DB では写しを作らない", () => {
    openRegistry();
    openAuth();
    const entityId = randomUUIDv7();
    openTenant(entityId);
    expect(copies()).toEqual([]);
    closeAll();
    // 今の版の既存の DB を開き直す
    openRegistry();
    openAuth();
    openTenant(entityId);
    expect(existsSync(preMigrateDir())).toBe(false);
  });

  it(`保持数（${PRE_MIGRATE_KEEP}）を超えたら同じ種類の古いものから消し、他の種類・事業体・途中の写しには触れない`, () => {
    const dir = preMigrateDir();
    mkdirSync(dir, { recursive: true });
    const other = randomUUIDv7().toLowerCase();
    const seeded = [
      "registry-20000101-000000.sqlite",
      "registry-20000101-000001.sqlite",
      "registry-20000101-000001-2.sqlite",
      "registry-20000102-000000.sqlite",
      `tenant-${other}-19990101-000000.sqlite`,
      "auth-19990101-000000.sqlite",
    ];
    for (const n of seeded) writeFileSync(join(dir, n), "old");
    createOldDb(registryFile(), "registry", "registry", migrationCount("registry") - 1);
    openRegistry();
    const registryCopies = copies().filter((n) => n.startsWith("registry-"));
    expect(registryCopies).toHaveLength(PRE_MIGRATE_KEEP);
    // 残るのは新しい順の 3 つ（今回の写し + 種で入れた新しい 2 つ）
    expect(registryCopies).toContain("registry-20000102-000000.sqlite");
    expect(registryCopies).toContain("registry-20000101-000001-2.sqlite");
    expect(registryCopies).not.toContain("registry-20000101-000001.sqlite");
    expect(registryCopies).not.toContain("registry-20000101-000000.sqlite");
    expect(registryCopies.every((n) => STAMPED.test(n))).toBe(true);
    expect(copies()).toContain(`tenant-${other}-19990101-000000.sqlite`);
    expect(copies()).toContain("auth-19990101-000000.sqlite");
  });

  it("写しを取れなければマイグレーションを当てずに失敗する", () => {
    const oldCount = migrationCount("registry") - 1;
    createOldDb(registryFile(), "registry", "registry", oldCount);
    // 置き場所の名前にファイルを置いて、フォルダを作れなくする
    writeFileSync(preMigrateDir(), "not a directory");
    expect(() => openRegistry()).toThrow();
    closeAll();
    const db = openEncryptedSqlite(registryFile(), "registry", {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(applied(db)).toBe(oldCount);
    } finally {
      db.close();
    }
  });

  it("事業体を消すと、その事業体の写しも消える（他の事業体の写しは残る）", () => {
    const entityId = randomUUIDv7().toLowerCase();
    createOldDb(tenantFile(entityId), { tenant: entityId }, "tenant", migrationCount("tenant") - 1);
    openTenant(entityId);
    const dir = preMigrateDir();
    const other = `tenant-${randomUUIDv7().toLowerCase()}-19990101-000000.sqlite`;
    writeFileSync(join(dir, other), "old");
    expect(copies().filter((n) => n.startsWith(`tenant-${entityId}-`))).toHaveLength(1);
    removeTenantData(entityId);
    expect(copies()).toEqual([other]);
  });
});
