import { randomUUIDv7 } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database, drizzleOf } from "../src/driver.ts";
import { NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 007 T004。0009・0010（statement_batches・statement_audit_log の作り直し）が、
// 取込済みのデータを失わず、外部キーとトリガーを保つことを、0008 までの DB に当てて確かめる

const FULL = fileURLToPath(new URL("../drizzle/tenant", import.meta.url));

let tmp: TempDataDir;
let client: Database.Database;

beforeEach(() => {
  tmp = useTempDataDir("statement-migration");
  // 0008 までのマイグレーションだけの置き場所を作る
  const upTo0008 = join(tmp.dir, "migrations-0008");
  mkdirSync(upTo0008, { recursive: true });
  mkdirSync(join(upTo0008, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(FULL, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((e) => e.idx <= 8);
  for (const e of kept) copyFileSync(join(FULL, `${e.tag}.sql`), join(upTo0008, `${e.tag}.sql`));
  writeFileSync(
    join(upTo0008, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  client = new Database(join(tmp.dir, "migration.sqlite"));
  client.pragma("foreign_keys = ON");
  migrate(drizzleOf(client, {}), { migrationsFolder: upTo0008 });
});
afterEach(() => {
  client.close();
  tmp.cleanup();
});

const one = (sql: string, ...params: unknown[]) =>
  client.prepare(sql).get(...params) as Record<string, unknown>;
const rows = (sql: string, ...params: unknown[]) =>
  client.prepare(sql).all(...params) as Record<string, unknown>[];

function seedOldData(): { batchId: string; statementId: string } {
  const accountId = randomUUIDv7();
  client
    .prepare(
      "INSERT INTO accounts (id, code, name, category, normal_side, report_section, sort_order, is_system, is_active) VALUES (?, '9001', '現金', 'asset', 'debit', 'BS_ASSET', 1, 0, 1)",
    )
    .run(accountId);
  const statementAccountId = randomUUIDv7();
  client
    .prepare(
      "INSERT INTO statement_accounts (id, name, usage, kind, account_id, sub_account_id, created_at, updated_at) VALUES (?, '銀行', 'mixed', 'bank', ?, NULL, ?, ?)",
    )
    .run(statementAccountId, accountId, NOW, NOW);
  const batchId = randomUUIDv7();
  client
    .prepare(
      "INSERT INTO statement_batches (id, origin, input_sha256, period_from, period_to, count_new, count_existing, count_unreadable, created_at) VALUES (?, 'paste', ?, '2026-10-01', '2026-10-31', 1, 0, 0, ?)",
    )
    .run(batchId, "a".repeat(64), NOW);
  const statementId = randomUUIDv7();
  client
    .prepare(
      "INSERT INTO statements (id, batch_id, statement_account_id, stable_key, external_id, date, amount, content, normalized_content, category_major, category_minor, memo, transfer_flag, changed_json, changed_ack_at, excluded_at, excluded_reason, created_at) VALUES (?, ?, ?, 'k', NULL, '2026-10-01', -500, 'ランチ', 'ランチ', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?)",
    )
    .run(statementId, batchId, statementAccountId, NOW);
  client
    .prepare(
      "INSERT INTO statement_audit_log (id, occurred_at, target_type, target_id, action, reason, before_json, after_json) VALUES (?, ?, 'statement_batch', ?, 'create', NULL, NULL, NULL)",
    )
    .run(randomUUIDv7(), NOW, batchId);
  return { batchId, statementId };
}

describe("0009・0010 を取込済みの DB に当てる", () => {
  it("取込の回・明細・操作の記録が残り、外部キーの検査が通り、トリガーが作り直される", () => {
    const { batchId, statementId } = seedOldData();

    migrate(drizzleOf(client, {}), { migrationsFolder: FULL });

    // データが残る（mfme_fetch の取込は作られたことがない。R13）
    expect(one("SELECT COUNT(*) AS n FROM statement_batches").n).toBe(1);
    expect(one("SELECT source_name FROM statement_batches WHERE id = ?", batchId).source_name).toBe(
      null,
    );
    expect(one("SELECT batch_id FROM statements WHERE id = ?", statementId).batch_id).toBe(batchId);
    expect(one("SELECT COUNT(*) AS n FROM statement_audit_log").n).toBe(1);
    expect(rows("PRAGMA foreign_key_check")).toEqual([]);
    expect(
      rows("PRAGMA foreign_key_list(statements)")
        .filter((r) => r.from === "batch_id")
        .map((r) => r.table),
    ).toEqual(["statement_batches"]);
    expect(rows("PRAGMA index_list(statement_audit_log)").map((r) => r.name)).toContain(
      "statement_audit_log_target",
    );

    // トリガーが効く
    expect(() => client.prepare("DELETE FROM statement_batches").run()).toThrow(
      /cannot be deleted/,
    );
    expect(() => client.prepare("UPDATE statement_batches SET count_new = 9").run()).toThrow(
      /append-only/,
    );
    expect(() => client.prepare("DELETE FROM statement_audit_log").run()).toThrow(/append-only/);
    expect(() => client.prepare("UPDATE statement_audit_log SET reason = 'x'").run()).toThrow(
      /append-only/,
    );
  });
});
