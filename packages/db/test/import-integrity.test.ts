import { randomUUIDv7 } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzleOf } from "../src/driver.ts";
import { openEncryptedSqlite, openTenant, type TenantDb, tenantFile } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
const ids = { period: "", account: "", subAccount: "", batch: "" };
const now = "2026-01-01T00:00:00.000Z";
const SHA = "0123456789abcdef".repeat(4);

const run = (sql: string, ...params: unknown[]) => db.$client.prepare(sql).run(...params);

function insertJournal(no: number): string {
  const id = randomUUIDv7();
  run(
    "INSERT INTO journals (id, journal_no, date, fiscal_period_id, status, source, created_at, updated_at) VALUES (?, ?, '2025-03-01', ?, 'active', 'import_freee', ?, ?)",
    id,
    no,
    ids.period,
    now,
    now,
  );
  return id;
}

function insertBatch(overrides: Record<string, unknown> = {}): string {
  const row = {
    id: randomUUIDv7(),
    source: "freee_journal",
    file_name: "journal.csv",
    file_sha256: SHA,
    imported_at: now,
    period_from: "2025-01-01",
    period_to: "2025-12-31",
    fiscal_years_json: "[2025]",
    count_new: 1,
    count_already: 0,
    count_excluded: 0,
    count_rejected: 0,
    count_warnings: 0,
    status: "active",
    voided_at: null,
    void_reason: null,
    ...overrides,
  };
  const cols = Object.keys(row);
  run(
    `INSERT INTO import_batches (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
  return row.id as string;
}

function insertRef(journalId: string, freeeJournalId: string, batchId = ids.batch): void {
  run(
    "INSERT INTO import_journal_refs (journal_id, batch_id, freee_journal_id, freee_journal_no, freee_date, snapshot_json) VALUES (?, ?, ?, '1', '2025-03-01', '{}')",
    journalId,
    batchId,
    freeeJournalId,
  );
}

beforeEach(() => {
  tmp = useTempDataDir("import-integrity");
  db = openTenant(randomUUIDv7());
  ids.period = randomUUIDv7();
  ids.account = randomUUIDv7();
  ids.subAccount = randomUUIDv7();
  run(
    "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES (?, 2025, '2025-01-01', '2025-12-31', 'open')",
    ids.period,
  );
  run(
    "INSERT INTO accounts (id, code, name, category, normal_side, report_section, sort_order, is_system, is_active) VALUES (?, '2020', '未払金', 'liability', 'credit', 'BS_LIABILITY', 1, 1, 1)",
    ids.account,
  );
  run(
    "INSERT INTO sub_accounts (id, account_id, name, is_active) VALUES (?, ?, 'カード', 1)",
    ids.subAccount,
    ids.account,
  );
  ids.batch = insertBatch();
});
afterEach(() => tmp.cleanup());

describe("取込の記録の整合性（0002_import のトリガー・CHECK・インデックス）", () => {
  it("取込の回の削除はトリガーで拒否される", () => {
    expect(() => run("DELETE FROM import_batches WHERE id = ?", ids.batch)).toThrow(
      /import_batches cannot be deleted/,
    );
  });

  it("参照の削除はトリガーで拒否される", () => {
    const journalId = insertJournal(1);
    insertRef(journalId, "F-1");
    expect(() => run("DELETE FROM import_journal_refs WHERE journal_id = ?", journalId)).toThrow(
      /import_journal_refs cannot be deleted/,
    );
  });

  it.each([
    ["freee_journal_id", "'F-9'"],
    ["freee_journal_no", "'9'"],
    ["freee_date", "'2025-04-01'"],
    ["snapshot_json", "'{\"x\":1}'"],
  ])("参照の %s の更新は拒否される", (column, value) => {
    const journalId = insertJournal(1);
    insertRef(journalId, "F-1");
    expect(() =>
      run(`UPDATE import_journal_refs SET ${column} = ${value} WHERE journal_id = ?`, journalId),
    ).toThrow(/only revoked_at can be set/);
  });

  it("参照の batch_id・journal_id の更新は拒否される", () => {
    const journalId = insertJournal(1);
    insertRef(journalId, "F-1");
    const other = insertBatch();
    expect(() =>
      run("UPDATE import_journal_refs SET batch_id = ? WHERE journal_id = ?", other, journalId),
    ).toThrow(/only revoked_at can be set/);
    const otherJournal = insertJournal(2);
    expect(() =>
      run(
        "UPDATE import_journal_refs SET journal_id = ? WHERE journal_id = ?",
        otherJournal,
        journalId,
      ),
    ).toThrow(/only revoked_at can be set/);
  });

  it("revoked_at は設定できるが、設定した後に戻すこと・変えることはできない", () => {
    const journalId = insertJournal(1);
    insertRef(journalId, "F-1");
    expect(() =>
      run("UPDATE import_journal_refs SET revoked_at = ? WHERE journal_id = ?", now, journalId),
    ).not.toThrow();
    expect(() =>
      run("UPDATE import_journal_refs SET revoked_at = NULL WHERE journal_id = ?", journalId),
    ).toThrow(/only revoked_at can be set/);
    expect(() =>
      run(
        "UPDATE import_journal_refs SET revoked_at = '2027-01-01T00:00:00.000Z' WHERE journal_id = ?",
        journalId,
      ),
    ).toThrow(/only revoked_at can be set/);
  });

  it("取り消されていない参照で同じ freee の仕訳ID は2件入らないが、revoked_at の設定後なら入る（INV-12）", () => {
    const first = insertJournal(1);
    const second = insertJournal(2);
    insertRef(first, "F-1");
    expect(() => insertRef(second, "F-1")).toThrow(/UNIQUE constraint failed/);
    run("UPDATE import_journal_refs SET revoked_at = ? WHERE journal_id = ?", now, first);
    expect(() => insertRef(second, "F-1")).not.toThrow();
    const third = insertJournal(3);
    expect(() => insertRef(third, "F-1")).toThrow(/UNIQUE constraint failed/);
  });

  it("参照の journal_id は journals への外部キー", () => {
    expect(() => insertRef(randomUUIDv7(), "F-1")).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("status = voided で void_reason が NULL なら拒否される", () => {
    expect(() => insertBatch({ status: "voided", voided_at: now })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      run(
        "UPDATE import_batches SET status = 'voided', voided_at = ? WHERE id = ?",
        now,
        ids.batch,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      run(
        "UPDATE import_batches SET status = 'voided', voided_at = ?, void_reason = '誤り' WHERE id = ?",
        now,
        ids.batch,
      ),
    ).not.toThrow();
  });

  it.each([
    [{ source: "freee_ledger" }],
    [{ file_sha256: SHA.toUpperCase() }],
    [{ file_sha256: SHA.slice(1) }],
    [{ count_new: 0 }],
    [{ count_rejected: -1 }],
    [{ status: "deleted" }],
  ])("取込の回の CHECK %o", (overrides) => {
    expect(() => insertBatch(overrides)).toThrow(/CHECK constraint failed/);
  });

  it("対応表で補助科目の ID と名前の両方は拒否される", () => {
    const insert = (source: string, subId: string | null, subName: string | null) =>
      run(
        "INSERT INTO import_account_mappings (source_name, account_id, sub_account_id, sub_account_name, updated_at) VALUES (?, ?, ?, ?, ?)",
        source,
        ids.account,
        subId,
        subName,
        now,
      );
    expect(() => insert("A", ids.subAccount, "カード")).toThrow(/CHECK constraint failed/);
    expect(() => insert("B", ids.subAccount, null)).not.toThrow();
    expect(() => insert("C", null, "新しいカード")).not.toThrow();
    expect(() => insert("D", null, null)).not.toThrow();
  });

  it("税区分の対応表は tax_categories への外部キー", () => {
    const insert = (code: string) =>
      run(
        "INSERT INTO import_tax_mappings (source_name, tax_category, updated_at) VALUES (?, ?, ?)",
        code,
        code,
        now,
      );
    expect(() => insert("SALES_10")).not.toThrow();
    expect(() => insert("UNKNOWN")).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("追加したテーブルは STRICT", () => {
    const tables = db.$client
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'import_%'")
      .all() as { name: string; sql: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual([
      "import_account_mappings",
      "import_batches",
      "import_journal_refs",
      "import_tax_mappings",
    ]);
    for (const t of tables) expect(t.sql).toMatch(/\)\s*STRICT$/);
  });
});

describe("既存の DB への 0002 の適用", () => {
  const MIGRATIONS = fileURLToPath(new URL("../drizzle/tenant", import.meta.url));

  /** 0000・0001 だけのマイグレーションのフォルダを .tmp に作る */
  function migrationsUpTo0001(dir: string): string {
    const out = join(dir, "migrations-0001");
    mkdirSync(join(out, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag < "0002");
    expect(journal.entries.map((e) => e.tag)).toEqual(["0000_init", "0001_integrity"]);
    writeFileSync(join(out, "meta", "_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
    }
    return out;
  }

  it("0000・0001 を適用済みの DB を開くと 0002 が当たり、既存のデータは残る", () => {
    const entityId = randomUUIDv7();
    const file = tenantFile(entityId);
    mkdirSync(join(file, ".."), { recursive: true });
    const client = openEncryptedSqlite(file, { tenant: entityId });
    client.pragma("foreign_keys = ON");
    migrate(drizzleOf(client, {}), { migrationsFolder: migrationsUpTo0001(tmp.dir) });
    const periodId = randomUUIDv7();
    client
      .prepare(
        "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES (?, 2025, '2025-01-01', '2025-12-31', 'open')",
      )
      .run(periodId);
    const journalId = randomUUIDv7();
    client
      .prepare(
        "INSERT INTO journals (id, journal_no, date, fiscal_period_id, status, created_at, updated_at) VALUES (?, 1, '2025-01-10', ?, 'active', ?, ?)",
      )
      .run(journalId, periodId, now, now);
    const before = client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'import_%'")
      .all();
    expect(before).toEqual([]);
    client.close();

    const reopened = openTenant(entityId);
    const c = reopened.$client;
    // 以降のマイグレーション（003 など）が増えても、journal の全件が適用される
    const all = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    expect(c.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual({
      n: all.entries.length,
    });
    expect(
      c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'import_%'")
        .all(),
    ).toHaveLength(4);
    expect(
      c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'import_%'")
        .all(),
    ).toHaveLength(3);
    expect(c.prepare("SELECT id, source FROM journals").all()).toEqual([
      { id: journalId, source: "manual" },
    ]);
  });
});
