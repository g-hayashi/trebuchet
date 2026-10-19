import { randomUUIDv7 } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: ReturnType<typeof openTenant>;
const ids = { period: "", account: "", journal: "" };

const now = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  tmp = useTempDataDir("integrity");
  db = openTenant(randomUUIDv7());
  const c = db.$client;
  ids.period = randomUUIDv7();
  ids.account = randomUUIDv7();
  ids.journal = randomUUIDv7();
  c.prepare(
    "INSERT INTO fiscal_periods (id, fiscal_year, start_date, end_date, status) VALUES (?, 2026, '2026-01-01', '2026-12-31', 'open')",
  ).run(ids.period);
  c.prepare(
    "INSERT INTO accounts (id, code, name, category, normal_side, report_section, sort_order, is_system, is_active) VALUES (?, '100', '現金', 'asset', 'debit', 'BS_ASSET', 1, 1, 1)",
  ).run(ids.account);
  c.prepare(
    "INSERT INTO journals (id, journal_no, date, fiscal_period_id, status, created_at, updated_at) VALUES (?, 1, '2026-01-10', ?, 'active', ?, ?)",
  ).run(ids.journal, ids.period, now, now);
});
afterEach(() => tmp.cleanup());

const insertLine = (lineNo: number, side: string, amount: number) =>
  db.$client
    .prepare(
      "INSERT INTO journal_lines (id, journal_id, line_no, side, account_id, amount, tax_category, tax_amount) VALUES (?, ?, ?, ?, ?, ?, 'OUT_OF_SCOPE', 0)",
    )
    .run(randomUUIDv7(), ids.journal, lineNo, side, ids.account, amount);

const insertAudit = () => {
  const id = randomUUIDv7();
  db.$client
    .prepare(
      "INSERT INTO audit_log (id, occurred_at, target_type, target_id, action) VALUES (?, ?, 'journal', ?, 'create')",
    )
    .run(id, now, ids.journal);
  return id;
};

describe("DB の整合性（トリガー・CHECK・ビュー）", () => {
  it("journals の DELETE は失敗する（FR-022）", () => {
    expect(() => db.$client.prepare("DELETE FROM journals WHERE id = ?").run(ids.journal)).toThrow(
      /journals cannot be deleted/,
    );
  });

  it("audit_log の UPDATE・DELETE は失敗する（INV-9）", () => {
    const id = insertAudit();
    expect(() =>
      db.$client.prepare("UPDATE audit_log SET reason = 'x' WHERE id = ?").run(id),
    ).toThrow(/append-only/);
    expect(() => db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
  });

  it.each([0, -1, 1e12])("amount = %d は CHECK で失敗する（INV-3）", (amount) => {
    expect(() => insertLine(1, "debit", amount)).toThrow(/CHECK constraint failed/);
  });

  it("amount = 1e12 - 1 は登録できる", () => {
    expect(() => insertLine(1, "debit", 1e12 - 1)).not.toThrow();
  });

  it("STRICT により、金額に小数は入らない", () => {
    expect(() => insertLine(1, "debit", 1.5)).toThrow(/cannot store REAL value/);
  });

  it("PRAGMA foreign_keys が ON で、存在しない科目は参照できない", () => {
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO journal_lines (id, journal_id, line_no, side, account_id, amount, tax_category, tax_amount) VALUES (?, ?, 1, 'debit', ?, 100, 'OUT_OF_SCOPE', 0)",
        )
        .run(randomUUIDv7(), ids.journal, randomUUIDv7()),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("v_unbalanced_journals は貸借不一致・片側のみの仕訳を検出する", () => {
    const unbalanced = () =>
      db.$client.prepare("SELECT journal_id FROM v_unbalanced_journals").all() as {
        journal_id: string;
      }[];
    // 行がない
    expect(unbalanced().map((r) => r.journal_id)).toEqual([ids.journal]);
    // 借方のみ
    insertLine(1, "debit", 1000);
    expect(unbalanced()).toHaveLength(1);
    // 貸借不一致
    insertLine(2, "credit", 999);
    expect(unbalanced()).toHaveLength(1);
    // 一致
    insertLine(3, "credit", 1);
    expect(unbalanced()).toHaveLength(0);
  });

  it("取消済みの仕訳は v_unbalanced_journals の対象外", () => {
    db.$client.prepare("UPDATE journals SET status = 'voided' WHERE id = ?").run(ids.journal);
    expect(db.$client.prepare("SELECT * FROM v_unbalanced_journals").all()).toHaveLength(0);
  });
});
