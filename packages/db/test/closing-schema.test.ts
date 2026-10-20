import { randomUUIDv7 } from "node:crypto";
import { TAX_PARAMETERS } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
beforeEach(() => {
  tmp = useTempDataDir("closing-schema");
  db = openTenant(randomUUIDv7());
});
afterEach(() => tmp.cleanup());

const NEW_TABLES = [
  "tax_parameters",
  "home_use_allocations",
  "rent_details",
  "fixed_assets",
  "adjustment_journal_refs",
  "blue_deduction_answers",
  "closing_notes",
  "tax_return_memos",
  "filed_documents",
  "closing_audit_log",
];

const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);
const NOW = "2026-10-19T09:00:00.000Z";

function seedAccount(code: string, name: string, category = "expense"): string {
  const id = randomUUIDv7();
  run(
    "INSERT INTO accounts (id, code, name, category, normal_side, report_section, report_line, sort_order, is_system, is_active) VALUES (?, ?, ?, ?, 'debit', 'PL_EXPENSE', NULL, 1, 0, 1)",
    id,
    code,
    name,
    category,
  );
  return id;
}

function seedPeriod(year: number): string {
  const id = randomUUIDv7();
  run(
    "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status, closed_at) VALUES (?, ?, ?, ?, 'open', NULL)",
    id,
    year,
    `${year + 1}-01-01`,
    `${year + 1}-12-31`,
  );
  return id;
}

function seedJournal(periodId: string, no: number): string {
  const id = randomUUIDv7();
  run(
    "INSERT INTO journals (id, journal_no, date, fiscal_period_id, memo, status, source, version, created_at, updated_at) VALUES (?, ?, '2026-12-31', ?, NULL, 'active', 'manual', 1, ?, ?)",
    id,
    no,
    periodId,
    NOW,
    NOW,
  );
  return id;
}

function insertAllocation(id: string, year: number, accountId: string, ratio = 5000, sub?: string) {
  run(
    "INSERT INTO home_use_allocations (id, fiscal_year, account_id, sub_account_id, business_ratio, basis, change_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '面積比', NULL, ?, ?)",
    id,
    year,
    accountId,
    sub ?? null,
    ratio,
    NOW,
    NOW,
  );
}

function insertAsset(
  id: string,
  accountId: string,
  overrides: { cost?: number; ratio?: number } = {},
) {
  run(
    "INSERT INTO fixed_assets (id, name, quantity, acquired_on, acquisition_cost, method, useful_life_years, business_ratio, asset_account_id, linked_journal_id, note, disposed_on, created_at, updated_at) VALUES (?, 'PC', NULL, '2026-05-01', ?, 'small_asset_28_2', NULL, ?, ?, NULL, NULL, NULL, ?, ?)",
    id,
    overrides.cost ?? 200_000,
    overrides.ratio ?? 10000,
    accountId,
    NOW,
    NOW,
  );
}

describe("003 の表（T007）", () => {
  it("新しい10表がすべて STRICT", () => {
    const rows = db.$client
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
      .all() as { name: string; sql: string }[];
    for (const name of NEW_TABLES) {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      expect(row?.sql, name).toMatch(/\)\s*STRICT$/);
    }
  });

  it("tax_parameters の投入値がドメインの TAX_PARAMETERS と同じ", () => {
    const rows = db.$client
      .prepare(
        "SELECT key, effective_from AS effectiveFrom, effective_to AS effectiveTo, value, source_url AS sourceUrl FROM tax_parameters",
      )
      .all() as (typeof TAX_PARAMETERS)[number][];
    const key = (r: { key: string; effectiveFrom: string }) => `${r.key}@${r.effectiveFrom}`;
    const sorted = (xs: readonly (typeof TAX_PARAMETERS)[number][]) =>
      [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    expect(rows).toHaveLength(6);
    expect(sorted(rows)).toEqual(sorted(TAX_PARAMETERS));
  });

  describe("CHECK と UNIQUE", () => {
    it("tax_parameters: key の列挙、value > 0", () => {
      const insert = (key: string, value: number) =>
        run(
          "INSERT INTO tax_parameters (key, effective_from, effective_to, value, source_url) VALUES (?, '2030-01-01', NULL, ?, 'https://example.com')",
          key,
          value,
        );
      expect(() => insert("UNKNOWN_KEY", 1)).toThrow(/CHECK/);
      expect(() => insert("BLUE_DEDUCTION_MAX", 0)).toThrow(/CHECK/);
      expect(() => insert("BLUE_DEDUCTION_MAX", 1)).not.toThrow();
    });

    it("home_use_allocations: business_ratio は 0〜10000、basis は空でない", () => {
      seedPeriod(2026);
      const account = seedAccount("9001", "地代家賃X");
      expect(() => insertAllocation("a1", 2026, account, -1)).toThrow(/CHECK/);
      expect(() => insertAllocation("a2", 2026, account, 10001)).toThrow(/CHECK/);
      expect(() =>
        run(
          "INSERT INTO home_use_allocations (id, fiscal_year, account_id, business_ratio, basis, created_at, updated_at) VALUES ('a3', 2026, ?, 5000, '', ?, ?)",
          account,
          NOW,
          NOW,
        ),
      ).toThrow(/CHECK/);
      expect(() => insertAllocation("a4", 2026, account, 0)).not.toThrow();
    });

    it("home_use_allocations: 年度は fiscal_periods に存在する", () => {
      const account = seedAccount("9001", "地代家賃X");
      expect(() => insertAllocation("a1", 2031, account)).toThrow(/FOREIGN KEY/);
    });

    it("home_use_allocations: sub_account_id が NULL でも (年度, 科目) の重複を防ぐ", () => {
      seedPeriod(2026);
      const account = seedAccount("9001", "地代家賃X");
      insertAllocation("a1", 2026, account);
      expect(() => insertAllocation("a2", 2026, account)).toThrow(/UNIQUE/);
      // 年度が違う、科目が違う、補助科目がある行は別
      seedPeriod(2027);
      const other = seedAccount("9002", "水道光熱費X");
      const sub = randomUUIDv7();
      run(
        "INSERT INTO sub_accounts (id, account_id, name, is_active) VALUES (?, ?, 'A', 1)",
        sub,
        account,
      );
      expect(() => insertAllocation("a3", 2027, account)).not.toThrow();
      expect(() => insertAllocation("a4", 2026, other)).not.toThrow();
      expect(() => insertAllocation("a5", 2026, account, 5000, sub)).not.toThrow();
      expect(() => insertAllocation("a6", 2026, account, 5000, sub)).toThrow(/UNIQUE/);
    });

    it("rent_details: annual_rent >= 0、0 <= deductible_amount <= annual_rent", () => {
      const insert = (rent: number, deductible: number, payee = "大家") =>
        run(
          "INSERT INTO rent_details (id, fiscal_year, payee, property, annual_rent, deductible_amount, sort_order) VALUES (?, 2026, ?, '事務所', ?, ?, 1)",
          randomUUIDv7(),
          payee,
          rent,
          deductible,
        );
      expect(() => insert(-1, 0)).toThrow(/CHECK/);
      expect(() => insert(100, 101)).toThrow(/CHECK/);
      expect(() => insert(100, -1)).toThrow(/CHECK/);
      expect(() => insert(100, 50, "")).toThrow(/CHECK/);
      expect(() => insert(0, 0)).not.toThrow();
      expect(() => insert(100, 100)).not.toThrow();
    });

    it("fixed_assets: acquisition_cost > 0、business_ratio、method の列挙", () => {
      const account = seedAccount("1060", "工具器具備品X", "asset");
      expect(() => insertAsset("f1", account, { cost: 0 })).toThrow(/CHECK/);
      expect(() => insertAsset("f2", account, { ratio: 10001 })).toThrow(/CHECK/);
      expect(() =>
        run(
          "INSERT INTO fixed_assets (id, name, acquired_on, acquisition_cost, method, business_ratio, asset_account_id, created_at, updated_at) VALUES ('f3', 'PC', '2026-05-01', 100, 'straight_line', 10000, ?, ?, ?)",
          account,
          NOW,
          NOW,
        ),
      ).toThrow(/CHECK/);
      expect(() => insertAsset("f4", account)).not.toThrow();
    });

    it("adjustment_journal_refs: kind に応じて allocation_id / asset_id が必須", () => {
      const period = seedPeriod(2026);
      const account = seedAccount("9001", "地代家賃X");
      const asset = seedAccount("1060", "工具器具備品X", "asset");
      insertAllocation("al1", 2026, account);
      insertAsset("as1", asset);
      const insert = (
        journalNo: number,
        kind: string,
        allocationId: string | null,
        assetId: string | null,
      ) =>
        run(
          "INSERT INTO adjustment_journal_refs (journal_id, kind, allocation_id, asset_id, fiscal_year) VALUES (?, ?, ?, ?, 2026)",
          seedJournal(period, journalNo),
          kind,
          allocationId,
          assetId,
        );
      expect(() => insert(1, "home_use", null, null)).toThrow(/CHECK/);
      expect(() => insert(2, "home_use", null, "as1")).toThrow(/CHECK/);
      expect(() => insert(3, "depreciation", null, null)).toThrow(/CHECK/);
      expect(() => insert(4, "depreciation", "al1", null)).toThrow(/CHECK/);
      expect(() => insert(5, "other", "al1", "as1")).toThrow(/CHECK/);
      expect(() => insert(6, "home_use", "al1", null)).not.toThrow();
      expect(() => insert(7, "depreciation", null, "as1")).not.toThrow();
    });

    it("blue_deduction_answers: フラグは 0/1", () => {
      const insert = (year: number, flag: number) =>
        run(
          "INSERT INTO blue_deduction_answers (fiscal_year, double_entry, statements_attached, filed_on_time, e_tax, electronic_books, updated_at) VALUES (?, ?, 1, 1, 1, 1, ?)",
          year,
          flag,
          NOW,
        );
      expect(() => insert(2026, 2)).toThrow(/CHECK/);
      expect(() => insert(2026, 1)).not.toThrow();
      expect(() => insert(2026, 0)).toThrow(/UNIQUE|PRIMARY/);
    });

    it("closing_notes: kind の列挙、(fiscal_year, kind) が主キー", () => {
      const insert = (kind: string) =>
        run(
          "INSERT INTO closing_notes (fiscal_year, kind, body, updated_at) VALUES (2026, ?, 'x', ?)",
          kind,
          NOW,
        );
      expect(() => insert("other")).toThrow(/CHECK/);
      expect(() => insert("special_circumstances")).not.toThrow();
      expect(() => insert("special_circumstances")).toThrow(/UNIQUE|PRIMARY/);
      expect(() => insert("opening_difference")).not.toThrow();
    });

    it("tax_return_memos: kind の列挙、amount >= 0", () => {
      const insert = (kind: string, amount: number | null) =>
        run(
          "INSERT INTO tax_return_memos (id, fiscal_year, kind, amount) VALUES (?, 2026, ?, ?)",
          randomUUIDv7(),
          kind,
          amount,
        );
      expect(() => insert("unknown", 1)).toThrow(/CHECK/);
      expect(() => insert("salary", -1)).toThrow(/CHECK/);
      expect(() => insert("salary", null)).not.toThrow();
      expect(() => insert("crypto", 0)).not.toThrow();
    });

    it("filed_documents: kind の列挙", () => {
      const insert = (kind: string) =>
        run(
          "INSERT INTO filed_documents (id, fiscal_year, kind, file_path) VALUES (?, 2026, ?, '/a/b.pdf')",
          randomUUIDv7(),
          kind,
        );
      expect(() => insert("unknown")).toThrow(/CHECK/);
      expect(() => insert("blue_return")).not.toThrow();
    });

    it("closing_audit_log: target_type（account_report_line を含む）と action の列挙", () => {
      const insert = (targetType: string, action: string) =>
        run(
          "INSERT INTO closing_audit_log (id, occurred_at, target_type, target_id, action) VALUES (?, ?, ?, 't', ?)",
          randomUUIDv7(),
          NOW,
          targetType,
          action,
        );
      expect(() => insert("journal", "create")).toThrow(/CHECK/);
      expect(() => insert("account_report_line", "void")).toThrow(/CHECK/);
      for (const t of [
        "home_use_allocation",
        "rent_detail",
        "fixed_asset",
        "blue_deduction_answer",
        "closing_note",
        "account_report_line",
      ]) {
        expect(() => insert(t, "update"), t).not.toThrow();
      }
      for (const a of ["create", "update", "dispose", "delete"]) {
        expect(() => insert("fixed_asset", a), a).not.toThrow();
      }
    });
  });

  describe("トリガー", () => {
    it("adjustment_journal_refs の削除を禁止する", () => {
      const period = seedPeriod(2026);
      const account = seedAccount("9001", "地代家賃X");
      insertAllocation("al1", 2026, account);
      const journalId = seedJournal(period, 1);
      run(
        "INSERT INTO adjustment_journal_refs (journal_id, kind, allocation_id, asset_id, fiscal_year) VALUES (?, 'home_use', 'al1', NULL, 2026)",
        journalId,
      );
      expect(() =>
        run("DELETE FROM adjustment_journal_refs WHERE journal_id = ?", journalId),
      ).toThrow(/cannot be deleted/);
      const n = db.$client.prepare("SELECT COUNT(*) AS n FROM adjustment_journal_refs").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    });

    it("closing_audit_log の更新と削除を禁止する", () => {
      run(
        "INSERT INTO closing_audit_log (id, occurred_at, target_type, target_id, action) VALUES ('c1', ?, 'fixed_asset', 'x', 'create')",
        NOW,
      );
      expect(() => run("UPDATE closing_audit_log SET reason = 'x' WHERE id = 'c1'")).toThrow(
        /append-only/,
      );
      expect(() => run("DELETE FROM closing_audit_log WHERE id = 'c1'")).toThrow(/append-only/);
    });
  });
});
