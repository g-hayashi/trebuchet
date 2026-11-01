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
