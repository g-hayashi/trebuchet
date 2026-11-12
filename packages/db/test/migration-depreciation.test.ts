import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Database } from "../src/driver.ts";
import { NOW } from "../src/testing.ts";

const DIR = fileURLToPath(new URL("../drizzle/tenant/", import.meta.url));

function statements(file: string): string[] {
  return readFileSync(`${DIR}${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("0011_depreciation: 作り直した表の行を写す（research R14）", () => {
  it("003 のデータ（除却済みの資産、参照、監査）が 009 の列の既定値で残り、外部キーが壊れない", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // 009 より前（0000〜0010）を適用する（drizzle のマイグレーターと同じ、トランザクションの中）
    const before = files.filter((f) => f < "0011");
    db.exec("BEGIN");
    for (const f of before) for (const s of statements(f)) db.exec(s);
    db.exec("COMMIT");

    db.exec(`
      INSERT INTO accounts (id, code, name, category, normal_side, report_section, report_line, sort_order, is_system, is_active)
        VALUES ('acc', '1060', '工具器具備品', 'asset', 'debit', 'BS_ASSET', NULL, 1, 0, 1);
      INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status, closed_at)
        VALUES ('p', 2026, '2026-01-01', '2026-12-31', 'open', NULL);
      INSERT INTO journals (id, journal_no, date, fiscal_period_id, memo, status, source, version, created_at, updated_at)
        VALUES ('j', 1, '2026-12-31', 'p', NULL, 'active', 'manual', 1, '${NOW}', '${NOW}');
      INSERT INTO fixed_assets (id, name, acquired_on, acquisition_cost, method, business_ratio, asset_account_id, disposed_on, created_at, updated_at)
        VALUES ('live', 'PC', '2026-05-01', 200000, 'small_asset_28_2', 10000, 'acc', NULL, '${NOW}', '${NOW}'),
               ('gone', 'PC2', '2026-05-01', 250000, 'small_asset_28_2', 5000, 'acc', '2026-09-30', '${NOW}', '${NOW}');
      INSERT INTO adjustment_journal_refs (journal_id, kind, allocation_id, asset_id, fiscal_year)
        VALUES ('j', 'depreciation', NULL, 'live', 2026);
      INSERT INTO closing_audit_log (id, occurred_at, target_type, target_id, action)
        VALUES ('c1', '${NOW}', 'fixed_asset', 'live', 'create');
    `);
    const taxBefore = db.prepare("SELECT COUNT(*) AS n FROM tax_parameters").get() as { n: number };

    // 0011 は 1 つのトランザクションで適用する
    db.exec("BEGIN");
    for (const s of statements("0011_depreciation.sql")) db.exec(s);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.exec("COMMIT");

    expect(
      db
        .prepare(
          "SELECT id, in_service_on, prior_accumulated, prior_through_year, disposed_on, disposal_kind FROM fixed_assets ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "gone",
        in_service_on: null,
        prior_accumulated: 0,
        prior_through_year: null,
        disposed_on: "2026-09-30",
        disposal_kind: "scrap",
      },
      {
        id: "live",
        in_service_on: null,
        prior_accumulated: 0,
        prior_through_year: null,
        disposed_on: null,
        disposal_kind: null,
      },
    ]);
    expect(
      db
        .prepare("SELECT journal_id, asset_id, deferred_asset_id FROM adjustment_journal_refs")
        .all(),
    ).toEqual([{ journal_id: "j", asset_id: "live", deferred_asset_id: null }]);
    expect(db.prepare("SELECT id FROM closing_audit_log").all()).toEqual([{ id: "c1" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tax_parameters").get()).toEqual(taxBefore);
    // 作り直した表は STRICT。一時の写しは残らない
    const names = (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.filter((n) => n.startsWith("__"))).toEqual([]);
    db.close();
  });
});
