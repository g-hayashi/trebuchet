import { randomUUIDv7 } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 005 の data-model §1・§2、research R15。DB のトリガー・CHECK・UNIQUE の検査はここに一本化する

let tmp: TempDataDir;
let db: TenantDb;
beforeEach(() => {
  tmp = useTempDataDir("invoicing-schema");
  db = openTenant(randomUUIDv7());
});
afterEach(() => tmp.cleanup());

const NEW_TABLES = [
  "invoice_settings",
  "partner_billing_terms",
  "work_hours",
  "invoices",
  "invoice_items",
  "invoice_payments",
  "recurring_journals",
  "recurring_journal_lines",
  "recurring_runs",
  "invoicing_audit_log",
];

const NOW = "2026-10-24T09:00:00.000Z";
const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);
const all = (sqlText: string, ...params: unknown[]) =>
  db.$client.prepare(sqlText).all(...params) as Record<string, unknown>[];

type Row = Record<string, unknown>;

function insert(table: string, row: Row): void {
  const cols = Object.keys(row);
  run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

function update(table: string, where: string, set: Row, ...params: unknown[]): void {
  const cols = Object.keys(set);
  run(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${where}`,
    ...Object.values(set),
    ...params,
  );
}

let journalNo = 0;
let seq = 0;

/** 2026 年度の期間（テストごとに1件。2回目以降は同じ ID を返す） */
function seedPeriod(): string {
  const existing = all("SELECT id FROM fiscal_periods WHERE fiscal_year = 2026")[0];
  if (existing) return existing.id as string;
  const id = randomUUIDv7();
  insert("fiscal_periods", {
    id,
    fiscal_year: 2026,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    status: "open",
  });
  return id;
}

function seedAccount(code: string, name = `科目${code}`): string {
  const id = randomUUIDv7();
  insert("accounts", {
    id,
    code,
    name,
    category: "asset",
    normal_side: "debit",
    report_section: "BS_ASSET",
    sort_order: 1,
    is_system: 0,
    is_active: 1,
  });
  return id;
}

function seedSubAccount(accountId: string): string {
  const id = randomUUIDv7();
  insert("sub_accounts", { id, account_id: accountId, name: "普通", is_active: 1 });
  return id;
}

let partnerNo = 0;

function seedPartner(name?: string): string {
  partnerNo += 1;
  const id = randomUUIDv7();
  insert("partners", { id, name: name ?? `株式会社${partnerNo}`, honorific: "御中", is_active: 1 });
  return id;
}

function seedJournal(periodId: string, source = "manual"): string {
  const id = randomUUIDv7();
  journalNo += 1;
  insert("journals", {
    id,
    journal_no: journalNo,
    date: "2026-10-31",
    fiscal_period_id: periodId,
    status: "active",
    source,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  return id;
}

const settingsRow = (over: Row = {}): Row => ({
  id: 1,
  issuer_name: "山田 太郎",
  trade_name: null,
  address: "東京都",
  contact: "taro@example.com",
  bank_account: "○○銀行",
  registration_number: null,
  tax_display: "inclusive_only",
  next_seq: 1,
  updated_at: NOW,
  ...over,
});

const termsRow = (partnerId: string, over: Row = {}): Row => ({
  partner_id: partnerId,
  billing_type: "hourly",
  unit_price: 5000,
  monthly_amount: null,
  due_months_after: 1,
  due_day: 31,
  default_item_name: "システム開発",
  billing_name: null,
  updated_at: NOW,
  ...over,
});

function invoiceRow(partnerId: string, journalId: string, over: Row = {}): Row {
  seq += 1;
  return {
    id: randomUUIDv7(),
    invoice_no: `20261031-${String(seq).padStart(3, "0")}`,
    seq,
    partner_id: partnerId,
    target_month: "2026-10",
    issue_date: "2026-10-31",
    sales_date: "2026-10-31",
    due_date: "2026-11-30",
    recipient_name: "株式会社A",
    recipient_honorific: "御中",
    issuer_json: "{}",
    tax_display: "inclusive_only",
    total: 110000,
    journal_id: journalId,
    created_at: NOW,
    voided_at: null,
    void_reason: null,
    void_journal_id: null,
    ...over,
  };
}

const itemRow = (invoiceId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  invoice_id: invoiceId,
  line_no: 1,
  name: "システム開発",
  quantity_halves: 40,
  unit: "時間",
  unit_price: 5000,
  amount: 100000,
  tax_category: "SALES_10",
  tax_rate: 10,
  ...over,
});

const paymentRow = (invoiceId: string, journalId: string, accountId: string, over: Row = {}) => ({
  id: randomUUIDv7(),
  invoice_id: invoiceId,
  received_on: "2026-11-30",
  amount: 110000,
  fee_amount: 0,
  deposit_account_id: accountId,
  deposit_sub_account_id: null,
  journal_id: journalId,
  created_at: NOW,
  voided_at: null,
  void_reason: null,
  void_journal_id: null,
  ...over,
});

const recurringRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  name: "家賃",
  memo: null,
  day_of_month: 25,
  start_month: "2026-04",
  end_month: null,
  status: "active",
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const recurringLineRow = (recurringId: string, accountId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  recurring_id: recurringId,
  line_no: 1,
  side: "debit",
  account_id: accountId,
  sub_account_id: null,
  amount: 50000,
  tax_category: null,
  partner_id: null,
  description: null,
  ...over,
});

const runRow = (recurringId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  recurring_id: recurringId,
  target_month: "2026-10",
  status: "skipped",
  journal_id: null,
  skip_reason: "今月は不要",
  created_at: NOW,
  acknowledged_at: null,
  ...over,
});

const auditRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  occurred_at: NOW,
  target_type: "invoice",
  target_id: randomUUIDv7(),
  action: "create",
  reason: null,
  before_json: null,
  after_json: null,
  ...over,
});

/** 請求書の周辺（期間・取引先・仕訳）を用意して、請求書を1件入れる */
function seedInvoice(over: Row = {}) {
  const period = seedPeriod();
  const partner = seedPartner();
  const journal = seedJournal(period, "invoice");
  const row = invoiceRow(partner, journal, over);
  insert("invoices", row);
  return { period, partner, journal, id: row.id as string, row };
}

describe("005 の表", () => {
  it("新しい10表がすべて STRICT", () => {
    const rows = all("SELECT name, sql FROM sqlite_schema WHERE type = 'table'") as {
      name: string;
      sql: string;
    }[];
    for (const name of NEW_TABLES) {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      expect(row?.sql, name).toMatch(/\)\s*STRICT$/);
    }
  });
});

describe("invoice_settings", () => {
  it("1行だけ（id = 1）。登録番号は T + 数字で 14 文字", () => {
    expect(() => insert("invoice_settings", settingsRow({ id: 2 }))).toThrow(/CHECK/);
    expect(() =>
      insert("invoice_settings", settingsRow({ registration_number: "X1234567890123" })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("invoice_settings", settingsRow({ registration_number: "T123456789012" })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("invoice_settings", settingsRow({ registration_number: "T1234567890123" })),
    ).not.toThrow();
    expect(() => insert("invoice_settings", settingsRow())).toThrow(/UNIQUE|PRIMARY/);
  });

  it("tax_display は separate・inclusive_only。next_seq は 1 以上", () => {
    expect(() => insert("invoice_settings", settingsRow({ tax_display: "x" }))).toThrow(/CHECK/);
    expect(() => insert("invoice_settings", settingsRow({ next_seq: 0 }))).toThrow(/CHECK/);
    expect(() =>
      insert("invoice_settings", settingsRow({ tax_display: "separate", next_seq: 1 })),
    ).not.toThrow();
  });

  it("invoice_settings_seq_floor: next_seq を発行済みの最大の seq 以下にできない", () => {
    insert("invoice_settings", settingsRow({ next_seq: 1 }));
    // 発行済みなし: 自由に直せる
    expect(() => update("invoice_settings", "id = 1", { next_seq: 5 })).not.toThrow();
    const { row } = seedInvoice({ seq: 5, invoice_no: "20261031-005" });
    expect(row.seq).toBe(5);
    expect(() => update("invoice_settings", "id = 1", { next_seq: 5 })).toThrow(/next_seq/);
    expect(() => update("invoice_settings", "id = 1", { next_seq: 3 })).toThrow(/next_seq/);
    expect(() => update("invoice_settings", "id = 1", { next_seq: 6 })).not.toThrow();
    // ほかの列だけの更新は通る
    expect(() => update("invoice_settings", "id = 1", { address: "大阪府" })).not.toThrow();
  });

  it("invoice_settings_seq_floor: 行を作り直しても下限を破れない", () => {
    seedInvoice({ seq: 7, invoice_no: "20261031-007" });
    expect(() => insert("invoice_settings", settingsRow({ next_seq: 7 }))).toThrow(/next_seq/);
    expect(() => insert("invoice_settings", settingsRow({ next_seq: 8 }))).not.toThrow();
  });
});

describe("partner_billing_terms", () => {
  it("hourly は unit_price > 0 かつ monthly_amount NULL", () => {
    const p = seedPartner();
    expect(() => insert("partner_billing_terms", termsRow(p, { unit_price: null }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("partner_billing_terms", termsRow(p, { unit_price: 0 }))).toThrow(/CHECK/);
    expect(() => insert("partner_billing_terms", termsRow(p, { monthly_amount: 1000 }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("partner_billing_terms", termsRow(p))).not.toThrow();
  });

  it("monthly は monthly_amount > 0 かつ unit_price NULL", () => {
    const p = seedPartner();
    const monthly = { billing_type: "monthly", unit_price: null, monthly_amount: 300000 };
    expect(() =>
      insert("partner_billing_terms", termsRow(p, { ...monthly, monthly_amount: null })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("partner_billing_terms", termsRow(p, { ...monthly, monthly_amount: 0 })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("partner_billing_terms", termsRow(p, { ...monthly, unit_price: 100 })),
    ).toThrow(/CHECK/);
    expect(() => insert("partner_billing_terms", termsRow(p, monthly))).not.toThrow();
  });

  it("billing_type の列挙、due_months_after は 0〜12、default_item_name は空でない", () => {
    const p = seedPartner();
    expect(() => insert("partner_billing_terms", termsRow(p, { billing_type: "daily" }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("partner_billing_terms", termsRow(p, { due_months_after: -1 }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("partner_billing_terms", termsRow(p, { due_months_after: 13 }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("partner_billing_terms", termsRow(p, { default_item_name: "" }))).toThrow(
      /CHECK/,
    );
  });

  it("due_day は 1〜28 または 31。29・30 は拒否", () => {
    const tryDay = (day: number) => {
      const p = seedPartner(`取引先${day}`);
      return () => insert("partner_billing_terms", termsRow(p, { due_day: day }));
    };
    for (const d of [0, 29, 30, 32]) expect(tryDay(d), String(d)).toThrow(/CHECK/);
    for (const d of [1, 28, 31]) expect(tryDay(d), String(d)).not.toThrow();
  });

  it("取引先への外部キー、1取引先1行", () => {
    expect(() => insert("partner_billing_terms", termsRow(randomUUIDv7()))).toThrow(/FOREIGN KEY/);
    const p = seedPartner();
    insert("partner_billing_terms", termsRow(p));
    expect(() => insert("partner_billing_terms", termsRow(p))).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("work_hours", () => {
  const row = (partnerId: string, over: Row = {}): Row => ({
    partner_id: partnerId,
    target_month: "2026-10",
    half_hours: 40,
    updated_at: NOW,
    ...over,
  });

  it("target_month は YYYY-MM、half_hours は 0 以上、（取引先, 月）は一意", () => {
    const p = seedPartner();
    expect(() => insert("work_hours", row(p, { target_month: "2026-1" }))).toThrow(/CHECK/);
    expect(() => insert("work_hours", row(p, { target_month: "2026/10" }))).toThrow(/CHECK/);
    expect(() => insert("work_hours", row(p, { half_hours: -1 }))).toThrow(/CHECK/);
    expect(() => insert("work_hours", row(p, { half_hours: 0 }))).not.toThrow();
    expect(() => insert("work_hours", row(p))).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert("work_hours", row(p, { target_month: "2026-11" }))).not.toThrow();
  });

  it("work_hours は上書きできる（更新は通る）", () => {
    const p = seedPartner();
    insert("work_hours", row(p));
    expect(() => update("work_hours", "partner_id = ?", { half_hours: 41 }, p)).not.toThrow();
  });
});

describe("invoices", () => {
  it("invoice_no・seq・journal_id は一意、seq >= 1", () => {
    const a = seedInvoice();
    const period = a.period;
    const journal2 = seedJournal(period, "invoice");
    expect(() =>
      insert("invoices", invoiceRow(a.partner, journal2, { invoice_no: a.row.invoice_no })),
    ).toThrow(/UNIQUE/);
    expect(() => insert("invoices", invoiceRow(a.partner, journal2, { seq: a.row.seq }))).toThrow(
      /UNIQUE/,
    );
    expect(() => insert("invoices", invoiceRow(a.partner, journal2, { seq: 0 }))).toThrow(/CHECK/);
    expect(() => insert("invoices", invoiceRow(a.partner, a.journal))).toThrow(/UNIQUE/);
    expect(() => insert("invoices", invoiceRow(a.partner, journal2))).not.toThrow();
  });

  it("CHECK: 宛名・敬称・税の表示・合計・取消の列の組", () => {
    const p = seedPartner();
    const period = seedPeriod();
    const tryRow = (over: Row) => () =>
      insert("invoices", invoiceRow(p, seedJournal(period, "invoice"), over));
    expect(tryRow({ recipient_name: "" })).toThrow(/CHECK/);
    expect(tryRow({ recipient_honorific: "殿" })).toThrow(/CHECK/);
    expect(tryRow({ tax_display: "x" })).toThrow(/CHECK/);
    expect(tryRow({ total: 0 })).toThrow(/CHECK/);
    expect(tryRow({ total: 1_000_000_000_000 })).toThrow(/CHECK/);
    expect(tryRow({ voided_at: NOW })).toThrow(/CHECK/);
    expect(tryRow({ void_reason: "誤発行" })).toThrow(/CHECK/);
    expect(tryRow({ voided_at: NOW, void_reason: "誤発行" })).not.toThrow();
    expect(tryRow({ total: 999_999_999_999 })).not.toThrow();
  });

  it("外部キー: 取引先・仕訳", () => {
    const period = seedPeriod();
    const p = seedPartner();
    expect(() => insert("invoices", invoiceRow(randomUUIDv7(), seedJournal(period)))).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => insert("invoices", invoiceRow(p, randomUUIDv7()))).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert("invoices", invoiceRow(p, seedJournal(period), { void_journal_id: randomUUIDv7() })),
    ).toThrow(/FOREIGN KEY/);
  });

  it("invoices_no_delete: 削除できない", () => {
    const a = seedInvoice();
    expect(() => run("DELETE FROM invoices WHERE id = ?", a.id)).toThrow(/cannot be deleted/);
  });

  it("invoices_void_only: 写しの列は更新できない", () => {
    const a = seedInvoice();
    for (const [col, value] of [
      ["recipient_name", "別の会社"],
      ["recipient_honorific", "様"],
      ["issuer_json", '{"x":1}'],
      ["tax_display", "separate"],
      ["total", 1],
      ["due_date", "2027-01-31"],
      ["issue_date", "2026-11-01"],
      ["sales_date", "2026-11-01"],
      ["target_month", "2026-09"],
      ["invoice_no", "X"],
      ["seq", 99],
      ["partner_id", seedPartner("別の取引先")],
    ] as const) {
      expect(() => update("invoices", "id = ?", { [col]: value }, a.id), col).toThrow(
        /only be voided|immutable/,
      );
    }
  });

  it("invoices_void_only: 取消の列は NULL から一度だけ。取消済みの行はもう更新できない", () => {
    const a = seedInvoice();
    expect(() =>
      update("invoices", "id = ?", { voided_at: NOW, void_reason: "誤発行" }, a.id),
    ).not.toThrow();
    expect(() => update("invoices", "id = ?", { void_reason: "別の理由" }, a.id)).toThrow(
      /only be voided|immutable/,
    );
    expect(() =>
      update("invoices", "id = ?", { voided_at: null, void_reason: null }, a.id),
    ).toThrow(/only be voided|immutable/);
    const b = seedInvoice();
    const voidJournal = seedJournal(b.period, "invoice");
    expect(() =>
      update(
        "invoices",
        "id = ?",
        { voided_at: NOW, void_reason: "締め後の取消", void_journal_id: voidJournal },
        b.id,
      ),
    ).not.toThrow();
  });
});

describe("invoice_items", () => {
  it("line_no は 1〜5、（請求書, 行）は一意", () => {
    const a = seedInvoice();
    expect(() => insert("invoice_items", itemRow(a.id, { line_no: 0 }))).toThrow(/CHECK/);
    expect(() => insert("invoice_items", itemRow(a.id, { line_no: 6 }))).toThrow(/CHECK/);
    expect(() => insert("invoice_items", itemRow(a.id, { line_no: 5 }))).not.toThrow();
    expect(() => insert("invoice_items", itemRow(a.id, { line_no: 5 }))).toThrow(/UNIQUE/);
  });

  it("CHECK: name・数量・単価・金額", () => {
    const a = seedInvoice();
    const tryRow = (over: Row) => () => insert("invoice_items", itemRow(a.id, over));
    expect(tryRow({ name: "" })).toThrow(/CHECK/);
    expect(tryRow({ quantity_halves: 0 })).toThrow(/CHECK/);
    expect(tryRow({ unit_price: 0 })).toThrow(/CHECK/);
    expect(tryRow({ amount: 0, quantity_halves: null, unit_price: null })).toThrow(/CHECK/);
    expect(tryRow({ amount: 1_000_000_000_000, quantity_halves: null, unit_price: null })).toThrow(
      /CHECK/,
    );
  });

  it("amount = quantity_halves × unit_price / 2（切り捨て）。数量か単価がなければ検査しない", () => {
    const a = seedInvoice();
    // 15 半時間 × 3333 / 2 = 24997.5 → 24997
    const tryAmount = (amount: number, line: number) => () =>
      insert(
        "invoice_items",
        itemRow(a.id, { line_no: line, quantity_halves: 15, unit_price: 3333, amount }),
      );
    expect(tryAmount(24998, 1)).toThrow(/CHECK/);
    expect(tryAmount(24997, 1)).not.toThrow();
    expect(() =>
      insert(
        "invoice_items",
        itemRow(a.id, { line_no: 2, quantity_halves: null, unit_price: null, amount: 12345 }),
      ),
    ).not.toThrow();
    expect(() =>
      insert(
        "invoice_items",
        itemRow(a.id, { line_no: 3, quantity_halves: null, unit_price: 7, amount: 12345 }),
      ),
    ).not.toThrow();
  });

  it("外部キー: 請求書・税区分", () => {
    const a = seedInvoice();
    expect(() => insert("invoice_items", itemRow(randomUUIDv7()))).toThrow(/FOREIGN KEY/);
    expect(() => insert("invoice_items", itemRow(a.id, { tax_category: "NOPE" }))).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("invoice_items_no_delete / invoice_items_no_update", () => {
    const a = seedInvoice();
    const item = itemRow(a.id);
    insert("invoice_items", item);
    expect(() => run("DELETE FROM invoice_items WHERE id = ?", item.id)).toThrow(
      /cannot be deleted/,
    );
    expect(() => update("invoice_items", "id = ?", { name: "別の品名" }, item.id)).toThrow(
      /cannot be updated/,
    );
  });
});

describe("invoice_payments", () => {
  function seedPayment(over: Row = {}) {
    const a = seedInvoice();
    const account = seedAccount("1010");
    const journal = seedJournal(a.period, "payment");
    const row = paymentRow(a.id, journal, account, over);
    insert("invoice_payments", row);
    return { ...a, account, paymentJournal: journal, payment: row };
  }

  it("CHECK: amount > 0、fee_amount >= 0、取消の列の組", () => {
    const a = seedInvoice();
    const account = seedAccount("1010");
    const tryRow = (over: Row) => () =>
      insert("invoice_payments", paymentRow(a.id, seedJournal(a.period, "payment"), account, over));
    expect(tryRow({ amount: 0 })).toThrow(/CHECK/);
    expect(tryRow({ fee_amount: -1 })).toThrow(/CHECK/);
    expect(tryRow({ voided_at: NOW })).toThrow(/CHECK/);
    expect(tryRow({ void_reason: "x" })).toThrow(/CHECK/);
    expect(tryRow({ fee_amount: 330 })).not.toThrow();
  });

  it("journal_id は一意。外部キー", () => {
    const p = seedPayment();
    expect(() => insert("invoice_payments", paymentRow(p.id, p.paymentJournal, p.account))).toThrow(
      /UNIQUE/,
    );
    expect(() =>
      insert("invoice_payments", paymentRow(randomUUIDv7(), seedJournal(p.period), p.account)),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert("invoice_payments", paymentRow(p.id, seedJournal(p.period), randomUUIDv7())),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert(
        "invoice_payments",
        paymentRow(p.id, seedJournal(p.period), p.account, {
          deposit_sub_account_id: randomUUIDv7(),
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
    const sub = seedSubAccount(p.account);
    expect(() =>
      insert(
        "invoice_payments",
        paymentRow(p.id, seedJournal(p.period), p.account, { deposit_sub_account_id: sub }),
      ),
    ).not.toThrow();
  });

  it("invoice_payments_no_delete: 削除できない", () => {
    const p = seedPayment();
    expect(() => run("DELETE FROM invoice_payments WHERE id = ?", p.payment.id)).toThrow(
      /cannot be deleted/,
    );
  });

  it("invoice_payments_void_only: 写しの列は更新できず、取消の列は一度だけ", () => {
    const p = seedPayment();
    for (const [col, value] of [
      ["amount", 1],
      ["fee_amount", 5],
      ["received_on", "2026-12-01"],
      ["invoice_id", seedInvoice().id],
    ] as const) {
      expect(
        () => update("invoice_payments", "id = ?", { [col]: value }, p.payment.id),
        col,
      ).toThrow(/only be voided|immutable/);
    }
    expect(() =>
      update("invoice_payments", "id = ?", { voided_at: NOW, void_reason: "誤入力" }, p.payment.id),
    ).not.toThrow();
    expect(() =>
      update("invoice_payments", "id = ?", { void_reason: "別の理由" }, p.payment.id),
    ).toThrow(/only be voided|immutable/);
  });
});

describe("recurring_journals / recurring_journal_lines", () => {
  it("CHECK: name、day_of_month（29・30 は不可）、月、end_month >= start_month、status、version", () => {
    const tryRow = (over: Row) => () => insert("recurring_journals", recurringRow(over));
    expect(tryRow({ name: "" })).toThrow(/CHECK/);
    for (const d of [0, 29, 30, 32])
      expect(tryRow({ day_of_month: d }), String(d)).toThrow(/CHECK/);
    for (const d of [1, 28, 31]) expect(tryRow({ day_of_month: d }), String(d)).not.toThrow();
    expect(tryRow({ start_month: "2026-4" })).toThrow(/CHECK/);
    expect(tryRow({ end_month: "2027-1" })).toThrow(/CHECK/);
    expect(tryRow({ end_month: "2026-03" })).toThrow(/CHECK/);
    expect(tryRow({ end_month: "2026-04" })).not.toThrow();
    expect(tryRow({ status: "stopped" })).toThrow(/CHECK/);
    expect(tryRow({ status: "paused" })).not.toThrow();
    expect(tryRow({ version: 0 })).toThrow(/CHECK/);
  });

  it("行: side、amount、（定義, 行番号）は一意、外部キー", () => {
    const account = seedAccount("6000");
    const rec = recurringRow();
    insert("recurring_journals", rec);
    const id = rec.id as string;
    const tryRow = (over: Row) => () =>
      insert("recurring_journal_lines", recurringLineRow(id, account, over));
    expect(tryRow({ side: "left" })).toThrow(/CHECK/);
    expect(tryRow({ amount: 0 })).toThrow(/CHECK/);
    expect(tryRow({ amount: 1_000_000_000_000 })).toThrow(/CHECK/);
    expect(tryRow({ line_no: 1 })).not.toThrow();
    expect(tryRow({ line_no: 1 })).toThrow(/UNIQUE/);
    expect(tryRow({ line_no: 2, tax_category: "NOPE" })).toThrow(/FOREIGN KEY/);
    expect(tryRow({ line_no: 2, partner_id: randomUUIDv7() })).toThrow(/FOREIGN KEY/);
    expect(
      tryRow({ line_no: 2, tax_category: "PURCHASE_10", partner_id: seedPartner() }),
    ).not.toThrow();
    expect(() =>
      insert("recurring_journal_lines", recurringLineRow(randomUUIDv7(), account)),
    ).toThrow(/FOREIGN KEY/);
  });

  it("定義の更新は通る（物理削除はしない方針だが、トリガーは掛けない）", () => {
    const rec = recurringRow();
    insert("recurring_journals", rec);
    expect(() =>
      update("recurring_journals", "id = ?", { status: "paused", version: 2 }, rec.id),
    ).not.toThrow();
  });
});

describe("recurring_runs", () => {
  function seedRecurring(): string {
    const rec = recurringRow();
    insert("recurring_journals", rec);
    return rec.id as string;
  }

  it("UNIQUE（定期仕訳, 月）", () => {
    const id = seedRecurring();
    insert("recurring_runs", runRow(id));
    expect(() => insert("recurring_runs", runRow(id))).toThrow(/UNIQUE/);
    expect(() => insert("recurring_runs", runRow(id, { target_month: "2026-11" }))).not.toThrow();
    const other = seedRecurring();
    expect(() => insert("recurring_runs", runRow(other))).not.toThrow();
  });

  it("CHECK: status の列挙、posted は journal_id が必須、skipped は journal_id なしで理由が必須", () => {
    const id = seedRecurring();
    const period = seedPeriod();
    const j = () => seedJournal(period, "recurring");
    const tryRow = (month: string, over: Row) => () =>
      insert("recurring_runs", runRow(id, { target_month: month, ...over }));
    expect(tryRow("2026-01", { status: "blocked" })).toThrow(/CHECK/);
    expect(tryRow("2026-02", { status: "posted", journal_id: null, skip_reason: null })).toThrow(
      /CHECK/,
    );
    expect(tryRow("2026-03", { status: "skipped", journal_id: j() })).toThrow(/CHECK/);
    expect(tryRow("2026-04", { status: "skipped", skip_reason: null })).toThrow(/CHECK/);
    expect(
      tryRow("2026-05", { status: "posted", journal_id: j(), skip_reason: null }),
    ).not.toThrow();
    expect(tryRow("2026-6", {})).toThrow(/CHECK/);
  });

  it("journal_id は一意で外部キー", () => {
    const id = seedRecurring();
    const period = seedPeriod();
    const journal = seedJournal(period, "recurring");
    insert(
      "recurring_runs",
      runRow(id, { status: "posted", journal_id: journal, skip_reason: null }),
    );
    expect(() =>
      insert(
        "recurring_runs",
        runRow(id, {
          target_month: "2026-11",
          status: "posted",
          journal_id: journal,
          skip_reason: null,
        }),
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert(
        "recurring_runs",
        runRow(id, {
          target_month: "2026-12",
          status: "posted",
          journal_id: randomUUIDv7(),
          skip_reason: null,
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("recurring_runs_no_delete: 削除できない", () => {
    const id = seedRecurring();
    const row = runRow(id);
    insert("recurring_runs", row);
    expect(() => run("DELETE FROM recurring_runs WHERE id = ?", row.id)).toThrow(
      /cannot be deleted/,
    );
  });

  it("recurring_runs_ack_only: acknowledged_at を NULL から付ける更新だけ通る", () => {
    const id = seedRecurring();
    const row = runRow(id);
    insert("recurring_runs", row);
    expect(() => update("recurring_runs", "id = ?", { skip_reason: "変更" }, row.id)).toThrow(
      /acknowledged_at/,
    );
    expect(() => update("recurring_runs", "id = ?", { status: "posted" }, row.id)).toThrow(
      /acknowledged_at/,
    );
    expect(() => update("recurring_runs", "id = ?", { target_month: "2026-12" }, row.id)).toThrow(
      /acknowledged_at/,
    );
    expect(() => update("recurring_runs", "id = ?", { acknowledged_at: null }, row.id)).toThrow(
      /acknowledged_at/,
    );
    expect(() =>
      update("recurring_runs", "id = ?", { acknowledged_at: NOW }, row.id),
    ).not.toThrow();
    // 一度付けたら、付け直し・外すことはできない
    expect(() =>
      update("recurring_runs", "id = ?", { acknowledged_at: "2026-10-25T00:00:00.000Z" }, row.id),
    ).toThrow(/acknowledged_at/);
    expect(() => update("recurring_runs", "id = ?", { acknowledged_at: null }, row.id)).toThrow(
      /acknowledged_at/,
    );
  });
});

describe("invoicing_audit_log", () => {
  it("target_type と action の列挙（CHECK）", () => {
    for (const t of [
      "invoice_settings",
      "billing_terms",
      "work_hours",
      "invoice",
      "payment",
      "recurring_journal",
      "recurring_run",
    ]) {
      expect(() => insert("invoicing_audit_log", auditRow({ target_type: t })), t).not.toThrow();
    }
    expect(() => insert("invoicing_audit_log", auditRow({ target_type: "journal" }))).toThrow(
      /CHECK/,
    );
    for (const a of ["create", "update", "void", "pause", "resume", "skip", "acknowledge"]) {
      expect(() => insert("invoicing_audit_log", auditRow({ action: a })), a).not.toThrow();
    }
    expect(() => insert("invoicing_audit_log", auditRow({ action: "delete" }))).toThrow(/CHECK/);
  });

  it("追記のみ: 更新・削除できない", () => {
    const row = auditRow();
    insert("invoicing_audit_log", row);
    expect(() => update("invoicing_audit_log", "id = ?", { reason: "x" }, row.id)).toThrow(
      /append-only/,
    );
    expect(() => run("DELETE FROM invoicing_audit_log WHERE id = ?", row.id)).toThrow(
      /append-only/,
    );
  });
});

describe("journals.source のトリガー（R15）", () => {
  it("manual・import_freee・invoice・payment・recurring を挿入できる。それ以外は拒否", () => {
    const period = seedPeriod();
    for (const source of ["manual", "import_freee", "invoice", "payment", "recurring"]) {
      expect(() => seedJournal(period, source), source).not.toThrow();
    }
    expect(() => seedJournal(period, "bogus")).toThrow(/source/);
  });

  it("更新でも列挙外の source にできない", () => {
    const period = seedPeriod();
    const id = seedJournal(period, "manual");
    expect(() => update("journals", "id = ?", { source: "bogus" }, id)).toThrow(/source/);
    expect(() => update("journals", "id = ?", { source: "recurring" }, id)).not.toThrow();
    // source 以外の更新は影響を受けない
    expect(() => update("journals", "id = ?", { memo: "メモ" }, id)).not.toThrow();
  });
});
