import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database, drizzleOf } from "../src/driver.ts";
import { DrizzleInvoicingStore } from "../src/invoicing-repository.ts";
import * as schema from "../src/schema/tenant.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

const FULL = fileURLToPath(new URL("../drizzle/tenant", import.meta.url));
let tmp: TempDataDir;
let client: Database.Database;
beforeEach(() => {
  tmp = useTempDataDir("invoicing-migration");
  const before = join(tmp.dir, "migrations-before-price-mode");
  mkdirSync(join(before, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(FULL, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const target = journal.entries.find((e) => e.tag.endsWith("_invoice_price_mode"));
  if (!target) throw new Error("invoice price mode migration missing");
  const entries = journal.entries.filter((e) => e.idx < target.idx);
  for (const e of entries) copyFileSync(join(FULL, `${e.tag}.sql`), join(before, `${e.tag}.sql`));
  writeFileSync(join(before, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  client = new Database(join(tmp.dir, "synthetic-old.sqlite"));
  client.pragma("foreign_keys = ON");
  migrate(drizzleOf(client, {}), { migrationsFolder: before });
});
afterEach(() => {
  client?.close();
  tmp.cleanup();
});

// 013（data-model §1.1〜1.4）: 源泉徴収の列。外部キーの検査は CHECK・トリガーの確認に要らないので切る
describe("源泉徴収の列（013）", () => {
  let full: Database.Database;
  beforeEach(() => {
    full = new Database(join(tmp.dir, "synthetic-full.sqlite"));
    full.pragma("foreign_keys = OFF");
    migrate(drizzleOf(full, {}), { migrationsFolder: FULL });
    full.exec(`
      INSERT INTO partners (id,name,is_active) VALUES ('p','合成取引先',1);
      INSERT INTO partner_billing_terms (partner_id,billing_type,unit_price,due_months_after,due_day,default_item_name,updated_at)
        VALUES ('p','hourly',6000,1,31,'業務','synthetic');
      INSERT INTO invoices (id,invoice_no,seq,partner_id,target_month,issue_date,sales_date,due_date,recipient_name,recipient_honorific,issuer_json,tax_display,total,journal_id,created_at)
        VALUES ('i','20261031-001',1,'p','2026-10','2026-10-31','2026-10-31','2026-11-30','合成取引先','御中','{}','inclusive_only',180000,'j','synthetic');
      INSERT INTO invoice_payments (id,invoice_id,received_on,amount,fee_amount,deposit_account_id,journal_id,created_at)
        VALUES ('pay','i','2026-11-30',100000,0,'a','jp','synthetic');
    `);
  });
  afterEach(() => full.close());

  it("3 表の新しい列の既定値は 0", () => {
    expect(full.prepare("SELECT withholding FROM partner_billing_terms").get()).toEqual({
      withholding: 0,
    });
    expect(full.prepare("SELECT withholding_base, withholding_tax FROM invoices").get()).toEqual({
      withholding_base: 0,
      withholding_tax: 0,
    });
    expect(full.prepare("SELECT withholding_amount FROM invoice_payments").get()).toEqual({
      withholding_amount: 0,
    });
  });

  it("CHECK: withholding は 0 か 1、withholding_amount は 0 以上", () => {
    expect(() => full.prepare("UPDATE partner_billing_terms SET withholding = 2").run()).toThrow(
      /CHECK/,
    );
    full.prepare("UPDATE partner_billing_terms SET withholding = 1").run();
    expect(() => full.prepare("UPDATE invoice_payments SET withholding_amount = -1").run()).toThrow(
      /CHECK/,
    );
  });

  let seq = 100;
  const insertInvoice = (base: number, tax: number) => {
    seq += 1;
    full
      .prepare(
        `INSERT INTO invoices (id,invoice_no,seq,partner_id,target_month,issue_date,sales_date,due_date,recipient_name,recipient_honorific,issuer_json,tax_display,total,journal_id,created_at,withholding_base,withholding_tax)
         VALUES (?,?,?,'p','2026-10','2026-10-31','2026-10-31','2026-11-30','合成取引先','御中','{}','inclusive_only',180000,?,'synthetic',?,?)`,
      )
      .run(`x${seq}`, `N${seq}`, seq, `j${seq}`, base, tax);
    return `x${seq}`;
  };

  it("CHECK: 0 ≤ withholding_tax ≤ withholding_base ≤ total（挿入で拒む）", () => {
    expect(() => insertInvoice(180_001, 0)).toThrow(/CHECK/);
    expect(() => insertInvoice(-1, -1)).toThrow(/CHECK/);
    expect(() => insertInvoice(100_000, 100_001)).toThrow(/CHECK/);
    expect(() => insertInvoice(100_000, -1)).toThrow(/CHECK/);
    insertInvoice(180_000, 180_000);
    insertInvoice(100_000, 10_210);
  });

  it("INV-38: 発行済みの withholding_base・withholding_tax の UPDATE をトリガーが拒む", () => {
    const id = insertInvoice(100_000, 10_210);
    for (const set of ["withholding_base = 100001", "withholding_tax = 10000"]) {
      expect(() => full.prepare(`UPDATE invoices SET ${set} WHERE id = ?`).run(id)).toThrow(
        /immutable/,
      );
    }
    expect(
      full.prepare("SELECT withholding_base, withholding_tax FROM invoices WHERE id = ?").get(id),
    ).toEqual({ withholding_base: 100_000, withholding_tax: 10_210 });
  });

  it("税制の値: 3 つの key が 2013-01-01〜2026-12-31 と 2027-01-01〜2047-12-31 の 2 期間で入っている", () => {
    expect(
      full
        .prepare(
          "SELECT key, effective_from, effective_to, value FROM tax_parameters WHERE key LIKE 'WITHHOLDING_%' ORDER BY key, effective_from",
        )
        .all(),
    ).toEqual([
      {
        key: "WITHHOLDING_RATE_HIGH",
        effective_from: "2013-01-01",
        effective_to: "2026-12-31",
        value: 2042,
      },
      {
        key: "WITHHOLDING_RATE_HIGH",
        effective_from: "2027-01-01",
        effective_to: "2047-12-31",
        value: 2042,
      },
      {
        key: "WITHHOLDING_RATE_LOW",
        effective_from: "2013-01-01",
        effective_to: "2026-12-31",
        value: 1021,
      },
      {
        key: "WITHHOLDING_RATE_LOW",
        effective_from: "2027-01-01",
        effective_to: "2047-12-31",
        value: 1021,
      },
      {
        key: "WITHHOLDING_THRESHOLD",
        effective_from: "2013-01-01",
        effective_to: "2026-12-31",
        value: 1_000_000,
      },
      {
        key: "WITHHOLDING_THRESHOLD",
        effective_from: "2027-01-01",
        effective_to: "2047-12-31",
        value: 1_000_000,
      },
    ]);
  });
});

describe("請求の方式の列を旧スキーマに追加する", () => {
  it("合成の既存条件・請求は税込になり、金額を保持し、税率は未指定になる", () => {
    client.exec(`
      INSERT INTO partners (id,name,is_active) VALUES ('p','合成取引先',1);
      INSERT INTO partner_billing_terms (partner_id,billing_type,unit_price,due_months_after,due_day,default_item_name,updated_at)
        VALUES ('p','hourly',6000,1,31,'業務','synthetic');
      INSERT INTO fiscal_periods (id,fiscal_year,start_date,end_date,status) VALUES ('period',2026,'2026-01-01','2026-12-31','open');
      INSERT INTO journals (id,journal_no,date,fiscal_period_id,status,source,created_at,updated_at)
        VALUES ('j',1,'2026-10-31','period','active','invoice','synthetic','synthetic');
      INSERT INTO invoices (id,invoice_no,seq,partner_id,target_month,issue_date,sales_date,due_date,recipient_name,recipient_honorific,issuer_json,tax_display,total,journal_id,created_at)
        VALUES ('i','20261031-001',1,'p','2026-10','2026-10-31','2026-10-31','2026-11-30','合成取引先','御中','{}','inclusive_only',180000,'j','synthetic');
    `);
    expect(client.prepare("PRAGMA table_info(invoices)").all()).not.toContainEqual(
      expect.objectContaining({ name: "price_mode" }),
    );
    migrate(drizzleOf(client, {}), { migrationsFolder: FULL });
    const store = new DrizzleInvoicingStore(drizzleOf(client, schema));
    expect(store.getBillingTerms("p")).toMatchObject({ priceMode: "inclusive", unitPrice: 6000 });
    expect(store.getBillingTerms("p")).not.toHaveProperty("taxRate");
    expect(store.getInvoice("i")).toMatchObject({ priceMode: "inclusive", total: 180000 });
    expect(client.prepare("SELECT tax_rate FROM partner_billing_terms").get()).toEqual({
      tax_rate: -1,
    });
    expect(client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => client.prepare("UPDATE invoices SET price_mode = 'exclusive'").run()).toThrow(
      /immutable/,
    );
  });
});
