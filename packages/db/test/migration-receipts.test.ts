import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Database } from "../src/driver.ts";

// 010 の 0014_receipts（data-model §5、research R20）。009 の migration-depreciation.test.ts と同じ形。
// tax_parameters の CHECK（key の列挙）を変えるので表を作り直す。既存の行（009 の行を含む）は残る

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
const receiptsFile = files.find((f) => f.startsWith("0014_"));

describe("0014_receipts: tax_parameters の作り直しで既存の行が残る（research R20）", () => {
  it("0014_receipts がある", () => {
    expect(receiptsFile).toBe("0014_receipts.sql");
  });

  it("0000〜0013 の行（003 の 5 行・009 の 4 行を含む）が 0014 の後も同じ値で残り、外部キーが壊れない", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("BEGIN");
    for (const f of files.filter((f) => f < "0014")) for (const s of statements(f)) db.exec(s);
    db.exec("COMMIT");

    const columns = "key, effective_from, effective_to, value, source_url";
    const before = db
      .prepare(`SELECT ${columns} FROM tax_parameters ORDER BY key, effective_from`)
      .all();
    expect(before.length).toBeGreaterThanOrEqual(9);
    expect(before.map((r) => (r as { key: string }).key)).toEqual(
      expect.arrayContaining([
        "BLUE_DEDUCTION_MAX",
        "LUMP_SUM_YEARS",
        "OPENING_COST_AMORTIZATION_MONTHS",
      ]),
    );

    // 010 の key は 0014 の前は入らない
    expect(() =>
      db.exec(
        "INSERT INTO tax_parameters (key, effective_from, effective_to, value, source_url) VALUES ('RECEIPT_SCAN_MIN_LONG_PX', '2024-01-01', NULL, 2338, 'u')",
      ),
    ).toThrow(/CHECK/);

    // 0014 は 1 つのトランザクションで適用する（drizzle のマイグレーターと同じ）
    db.exec("BEGIN");
    for (const s of statements(receiptsFile ?? "0014_receipts.sql")) db.exec(s);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.exec("COMMIT");

    expect(
      db.prepare(`SELECT ${columns} FROM tax_parameters ORDER BY key, effective_from`).all(),
    ).toEqual(before);
    // 4 つの新しい key が入るようになり、作り直した表は STRICT
    for (const key of [
      "RECEIPT_INPUT_CYCLE_MONTHS",
      "RECEIPT_INPUT_GRACE_BUSINESS_DAYS",
      "RECEIPT_SCAN_MIN_LONG_PX",
      "RECEIPT_SCAN_MIN_SHORT_PX",
    ]) {
      db.exec(
        `INSERT INTO tax_parameters (key, effective_from, effective_to, value, source_url) VALUES ('${key}', '2024-01-01', NULL, 1, 'u')`,
      );
    }
    expect(() =>
      db.exec(
        "INSERT INTO tax_parameters (key, effective_from, effective_to, value, source_url) VALUES ('NOT_A_KEY', '2024-01-01', NULL, 1, 'u')",
      ),
    ).toThrow(/CHECK/);
    const schema = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'tax_parameters'")
      .get() as { sql: string };
    expect(schema.sql).toMatch(/\)\s*STRICT$/);
    // 一時の写しは残らない
    const names = (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names.filter((n) => n.startsWith("__"))).toEqual([]);
    db.close();
  });
});
