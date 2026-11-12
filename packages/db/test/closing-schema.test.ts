import { randomUUIDv7 } from "node:crypto";
import { STRAIGHT_LINE_RATES, TAX_PARAMETERS } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

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
  "closing_audit_log",
];

/** 009 で足した表（data-model §1.1・§1.4・§1.5） */
const NEW_TABLES_009 = ["straight_line_rates", "deferred_assets", "deferred_amortizations"];

const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);

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
  it("新しい8表と 009 の 3 表がすべて STRICT（作り直した表を含む）", () => {
    const rows = db.$client
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
      .all() as { name: string; sql: string }[];
    for (const name of [...NEW_TABLES, ...NEW_TABLES_009]) {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      expect(row?.sql, name).toMatch(/\)\s*STRICT$/);
    }
  });

  it("申告の控えの表（011 R14 で消した）はない", () => {
    const names = (
      db.$client
        .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index')")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names.filter((n) => n.startsWith("tax_return_") || n.startsWith("filed_"))).toEqual([]);
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
    expect(rows).toHaveLength(20);
    expect(sorted(rows)).toEqual(sorted(TAX_PARAMETERS));
  });

  it("straight_line_rates の投入値がドメインの STRAIGHT_LINE_RATES と同じ（49 行、009 R2）", () => {
    const rows = db.$client
      .prepare(
        "SELECT useful_life_years AS usefulLifeYears, rate_permille AS ratePermille, effective_from AS effectiveFrom, effective_to AS effectiveTo, source_url AS sourceUrl FROM straight_line_rates ORDER BY useful_life_years",
      )
      .all();
    expect(rows).toHaveLength(49);
    expect(rows).toEqual(
      [...STRAIGHT_LINE_RATES].sort((a, b) => a.usefulLifeYears - b.usefulLifeYears),
    );
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
          "INSERT INTO fixed_assets (id, name, acquired_on, acquisition_cost, method, business_ratio, asset_account_id, created_at, updated_at) VALUES ('f3', 'PC', '2026-05-01', 100, 'declining_balance', 10000, ?, ?, ?)",
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

// ---- 009-depreciation-deferred（data-model §1.1〜1.7、research R14） ----

/** fixed_assets の 009 の列つきの挿入。overrides で列ごとに差し替える */
function insertAsset009(id: string, accountId: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    name: "PC",
    acquired_on: "2026-05-01",
    acquisition_cost: 500_000,
    method: "straight_line",
    useful_life_years: 4,
    business_ratio: 10000,
    asset_account_id: accountId,
    in_service_on: null,
    prior_accumulated: 0,
    prior_through_year: null,
    disposed_on: null,
    disposal_kind: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const cols = Object.keys(row);
  run(
    `INSERT INTO fixed_assets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

function insertDeferred(id: string, accountId: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    name: "開業費",
    total_amount: 600_000,
    opened_on: "2026-04-01",
    prior_accumulated: 0,
    prior_through_year: null,
    account_id: accountId,
    note: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const cols = Object.keys(row);
  run(
    `INSERT INTO deferred_assets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

describe("009 の表と CHECK（T005）", () => {
  it("straight_line_rates: 耐用年数 2〜50、率 1〜1000、出典 URL 必須、PK は (耐用年数, 適用開始日)", () => {
    const insert = (years: number, rate: number, source: string | null = "https://example.com") =>
      run(
        "INSERT INTO straight_line_rates (useful_life_years, effective_from, effective_to, rate_permille, source_url) VALUES (?, '2030-01-01', NULL, ?, ?)",
        years,
        rate,
        source,
      );
    expect(() => insert(1, 500)).toThrow(/CHECK/);
    expect(() => insert(51, 20)).toThrow(/CHECK/);
    expect(() => insert(4, 0)).toThrow(/CHECK/);
    expect(() => insert(4, 1001)).toThrow(/CHECK/);
    expect(() => insert(4, 250, null)).toThrow(/NOT NULL/);
    expect(() => insert(4, 250)).not.toThrow();
    expect(() => insert(4, 250)).toThrow(/UNIQUE|PRIMARY/);
  });

  it("tax_parameters: 009 の 4 つの key を入れられる（未知の key は拒否）", () => {
    const insert = (key: string) =>
      run(
        "INSERT INTO tax_parameters (key, effective_from, effective_to, value, source_url) VALUES (?, '2040-01-01', NULL, 1, 'https://example.com')",
        key,
      );
    expect(() => insert("LUMP_SUM_UNKNOWN")).toThrow(/CHECK/);
    for (const key of [
      "LUMP_SUM_COST_MIN",
      "LUMP_SUM_COST_MAX",
      "LUMP_SUM_YEARS",
      "OPENING_COST_AMORTIZATION_MONTHS",
    ]) {
      expect(() => insert(key), key).not.toThrow();
    }
  });

  describe("fixed_assets", () => {
    it("定額法は useful_life_years が必須。一括償却は NULL でよい。method の列挙", () => {
      const account = seedAccount("1060", "工具器具備品X", "asset");
      expect(() => insertAsset009("f1", account, { useful_life_years: null })).toThrow(/CHECK/);
      expect(() => insertAsset009("f2", account)).not.toThrow();
      expect(() =>
        insertAsset009("f3", account, {
          method: "lump_sum",
          useful_life_years: null,
          acquisition_cost: 150_000,
        }),
      ).not.toThrow();
      expect(() => insertAsset009("f4", account, { method: "declining_balance" })).toThrow(/CHECK/);
    });

    it("prior_accumulated は 0 以上、0 を超えるなら prior_through_year が必須", () => {
      const account = seedAccount("1060", "工具器具備品X", "asset");
      expect(() => insertAsset009("f1", account, { prior_accumulated: -1 })).toThrow(/CHECK/);
      expect(() => insertAsset009("f2", account, { prior_accumulated: 1000 })).toThrow(/CHECK/);
      expect(() =>
        insertAsset009("f3", account, { prior_accumulated: 1000, prior_through_year: 2026 }),
      ).not.toThrow();
      expect(() => insertAsset009("f4", account, { prior_accumulated: 0 })).not.toThrow();
    });

    it("disposal_kind と disposed_on は同時に NULL か同時に値。disposal_kind は scrap / sale", () => {
      const account = seedAccount("1060", "工具器具備品X", "asset");
      expect(() => insertAsset009("f1", account, { disposal_kind: "scrap" })).toThrow(/CHECK/);
      expect(() => insertAsset009("f2", account, { disposed_on: "2027-03-01" })).toThrow(/CHECK/);
      expect(() =>
        insertAsset009("f3", account, { disposed_on: "2027-03-01", disposal_kind: "gift" }),
      ).toThrow(/CHECK/);
      expect(() =>
        insertAsset009("f4", account, { disposed_on: "2027-03-01", disposal_kind: "scrap" }),
      ).not.toThrow();
      expect(() =>
        insertAsset009("f5", account, { disposed_on: "2027-03-01", disposal_kind: "sale" }),
      ).not.toThrow();
    });

    it("既存の insertAsset（009 の列を書かない挿入）は既定値で入る", () => {
      const account = seedAccount("1060", "工具器具備品X", "asset");
      insertAsset("f1", account);
      const row = db.$client
        .prepare(
          "SELECT in_service_on, prior_accumulated, prior_through_year, disposal_kind FROM fixed_assets WHERE id = 'f1'",
        )
        .get();
      expect(row).toEqual({
        in_service_on: null,
        prior_accumulated: 0,
        prior_through_year: null,
        disposal_kind: null,
      });
    });
  });

  describe("deferred_assets", () => {
    it("name は空でない、total_amount > 0、0 <= prior_accumulated <= total_amount", () => {
      const account = seedAccount("1080", "開業費X", "asset");
      expect(() => insertDeferred("d1", account, { name: "" })).toThrow(/CHECK/);
      expect(() => insertDeferred("d2", account, { total_amount: 0 })).toThrow(/CHECK/);
      expect(() => insertDeferred("d3", account, { prior_accumulated: -1 })).toThrow(/CHECK/);
      expect(() =>
        insertDeferred("d4", account, { prior_accumulated: 600_001, prior_through_year: 2026 }),
      ).toThrow(/CHECK/);
      expect(() =>
        insertDeferred("d5", account, { prior_accumulated: 600_000, prior_through_year: 2026 }),
      ).not.toThrow();
      expect(() => insertDeferred("d6", account)).not.toThrow();
    });

    it("prior_accumulated > 0 なら prior_through_year が必須", () => {
      const account = seedAccount("1080", "開業費X", "asset");
      expect(() => insertDeferred("d1", account, { prior_accumulated: 100 })).toThrow(/CHECK/);
      expect(() =>
        insertDeferred("d2", account, { prior_accumulated: 100, prior_through_year: 2026 }),
      ).not.toThrow();
    });

    it("account_id は accounts に存在する", () => {
      expect(() => insertDeferred("d1", "no-such-account")).toThrow(/FOREIGN KEY/);
    });
  });

  describe("deferred_amortizations", () => {
    const insert = (assetId: string, year: number, amount: number) =>
      run(
        "INSERT INTO deferred_amortizations (deferred_asset_id, fiscal_year, amount, decided_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        assetId,
        year,
        amount,
        NOW,
        NOW,
      );

    it("amount >= 0、(開業費, 年度) が主キー、両方の外部キー", () => {
      seedPeriod(2026);
      const account = seedAccount("1080", "開業費X", "asset");
      insertDeferred("d1", account);
      expect(() => insert("d1", 2026, -1)).toThrow(/CHECK/);
      expect(() => insert("d1", 2026, 0)).not.toThrow();
      expect(() => insert("d1", 2026, 100)).toThrow(/UNIQUE|PRIMARY/);
      expect(() => insert("d1", 2031, 100)).toThrow(/FOREIGN KEY/);
      expect(() => insert("nope", 2026, 100)).toThrow(/FOREIGN KEY/);
    });

    it("更新はできる（金額の変更）", () => {
      seedPeriod(2026);
      const account = seedAccount("1080", "開業費X", "asset");
      insertDeferred("d1", account);
      insert("d1", 2026, 100);
      expect(() =>
        run(
          "UPDATE deferred_amortizations SET amount = 200 WHERE deferred_asset_id = 'd1' AND fiscal_year = 2026",
        ),
      ).not.toThrow();
    });
  });

  describe("adjustment_journal_refs", () => {
    it("deferred_amortization は deferred_asset_id が必須。他の種別は従来どおり", () => {
      const period = seedPeriod(2026);
      const asset = seedAccount("1080", "開業費X", "asset");
      const account = seedAccount("9001", "地代家賃X");
      const fixed = seedAccount("1060", "工具器具備品X", "asset");
      insertDeferred("d1", asset);
      insertAllocation("al1", 2026, account);
      insertAsset("as1", fixed);
      const insert = (
        no: number,
        kind: string,
        cols: { allocationId?: string; assetId?: string; deferredAssetId?: string },
      ) =>
        run(
          "INSERT INTO adjustment_journal_refs (journal_id, kind, allocation_id, asset_id, deferred_asset_id, fiscal_year) VALUES (?, ?, ?, ?, ?, 2026)",
          seedJournal(period, no),
          kind,
          cols.allocationId ?? null,
          cols.assetId ?? null,
          cols.deferredAssetId ?? null,
        );
      expect(() => insert(1, "deferred_amortization", {})).toThrow(/CHECK/);
      expect(() => insert(2, "deferred_amortization", { assetId: "as1" })).toThrow(/CHECK/);
      expect(() => insert(3, "deferred_amortization", { deferredAssetId: "nope" })).toThrow(
        /FOREIGN KEY/,
      );
      expect(() => insert(4, "deferred_amortization", { deferredAssetId: "d1" })).not.toThrow();
      expect(() => insert(5, "depreciation", {})).toThrow(/CHECK/);
      expect(() => insert(6, "depreciation", { assetId: "as1" })).not.toThrow();
      expect(() => insert(7, "home_use", { allocationId: "al1" })).not.toThrow();
      expect(() => insert(8, "other", { allocationId: "al1" })).toThrow(/CHECK/);
    });
  });

  describe("トリガー（0012。0011 の作り直しで消えたものを含む）", () => {
    it("deferred_amortizations の削除を禁止する（更新はできる）", () => {
      seedPeriod(2026);
      const account = seedAccount("1080", "開業費X", "asset");
      insertDeferred("d1", account);
      run(
        "INSERT INTO deferred_amortizations (deferred_asset_id, fiscal_year, amount, decided_at, updated_at) VALUES ('d1', 2026, 100, ?, ?)",
        NOW,
        NOW,
      );
      expect(() =>
        run("DELETE FROM deferred_amortizations WHERE deferred_asset_id = 'd1'"),
      ).toThrow(/cannot be deleted/);
      const n = db.$client.prepare("SELECT COUNT(*) AS n FROM deferred_amortizations").get() as {
        n: number;
      };
      expect(n.n).toBe(1);
    });

    it("作り直した adjustment_journal_refs / closing_audit_log のトリガーが 3 つとも残っている", () => {
      const names = (
        db.$client.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "adjustment_journal_refs_no_delete",
          "closing_audit_log_no_update",
          "closing_audit_log_no_delete",
          "deferred_amortizations_no_delete",
        ]),
      );
    });
  });

  describe("closing_audit_log", () => {
    it("target_type に deferred_asset・deferred_amortization を入れられる", () => {
      const insert = (targetType: string) =>
        run(
          "INSERT INTO closing_audit_log (id, occurred_at, target_type, target_id, action) VALUES (?, ?, ?, 't', 'create')",
          randomUUIDv7(),
          NOW,
          targetType,
        );
      expect(() => insert("deferred_asset")).not.toThrow();
      expect(() => insert("deferred_amortization")).not.toThrow();
      expect(() => insert("deferred_other")).toThrow(/CHECK/);
    });
  });
});
