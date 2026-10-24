import { randomUUIDv7 } from "node:crypto";
import {
  createEntity,
  createJournal,
  type InvoicingAuditEntry,
  type JournalDraft,
  type JournalSource,
  type LedgerRepository,
  type MasterRepository,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleInvoicingStore, DrizzleInvoicingUnitOfWork } from "../src/invoicing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { DrizzleRecurringStore, DrizzleRecurringUnitOfWork } from "../src/recurring-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 005 R9・R23。UnitOfWork の巻き戻し、originOfJournal の往復、記録の追記を実 DB で確かめる

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-24T09:00:00.000Z" };
const NOW = clock.now();

beforeEach(() => {
  tmp = useTempDataDir("invoicing-uow");
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  db = openTenant(created.value.id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
});
afterEach(() => tmp.cleanup());

const run = (sqlText: string, params: unknown[] = []) => db.$client.prepare(sqlText).run(...params);
const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const accountId = (name: string) => {
  const a = masters.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a.id;
};

const draft = (amount = 110_000): JournalDraft => ({
  date: "2026-10-31",
  lines: [
    { side: "debit", accountId: accountId("売掛金"), amount },
    { side: "credit", accountId: accountId("売上高"), amount },
  ],
});

/** 与えた帳簿（トランザクション内のものでもよい）に仕訳を登録して ID を返す */
function post(
  source: JournalSource,
  deps: { ledger: LedgerRepository; masters: MasterRepository } = { ledger, masters },
): string {
  const r = createJournal({ ...deps, ids, clock }, draft(), { source });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.journal.id;
}

const audit = (over: Partial<InvoicingAuditEntry> = {}): InvoicingAuditEntry => ({
  id: randomUUIDv7(),
  occurredAt: NOW,
  targetType: "invoice",
  targetId: randomUUIDv7(),
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
  ...over,
});

/** 請求書・入金・定期仕訳の行を直接入れる（ユースケースは US1・US3 の実装で足す） */
function seedRows() {
  const partnerId = randomUUIDv7();
  run("INSERT INTO partners (id, name, honorific, is_active) VALUES (?, ?, ?, 1)", [
    partnerId,
    "株式会社A",
    "御中",
  ]);
  const invoiceJournal = post("invoice");
  const voidJournal = post("invoice");
  const paymentJournal = post("payment");
  const paymentVoidJournal = post("payment");
  const recurringJournal = post("recurring");
  const invoiceId = randomUUIDv7();
  run(
    `INSERT INTO invoices (id, invoice_no, seq, partner_id, target_month, issue_date, sales_date, due_date,
       recipient_name, recipient_honorific, issuer_json, tax_display, total, journal_id, created_at,
       voided_at, void_reason, void_journal_id)
     VALUES (?, '20261031-001', 1, ?, '2026-10', '2026-10-31', '2026-10-31', '2026-11-30',
       '株式会社A', '御中', '{}', 'inclusive_only', 110000, ?, ?, ?, '誤り', ?)`,
    [invoiceId, partnerId, invoiceJournal, NOW, NOW, voidJournal],
  );
  const paymentId = randomUUIDv7();
  run(
    `INSERT INTO invoice_payments (id, invoice_id, received_on, amount, fee_amount, deposit_account_id,
       journal_id, created_at, voided_at, void_reason, void_journal_id)
     VALUES (?, ?, '2026-11-30', 110000, 0, ?, ?, ?, ?, '誤り', ?)`,
    [paymentId, invoiceId, accountId("現金"), paymentJournal, NOW, NOW, paymentVoidJournal],
  );
  const recurringId = randomUUIDv7();
  run(
    `INSERT INTO recurring_journals (id, name, day_of_month, start_month, status, version, created_at, updated_at)
     VALUES (?, '家賃', 25, '2026-04', 'active', 1, ?, ?)`,
    [recurringId, NOW, NOW],
  );
  run(
    `INSERT INTO recurring_runs (id, recurring_id, target_month, status, journal_id, created_at)
     VALUES (?, ?, '2026-10', 'posted', ?, ?)`,
    [randomUUIDv7(), recurringId, recurringJournal, NOW],
  );
  return {
    invoiceId,
    paymentId,
    recurringId,
    invoiceJournal,
    voidJournal,
    paymentJournal,
    paymentVoidJournal,
    recurringJournal,
  };
}

describe("DrizzleInvoicingUnitOfWork（R9）", () => {
  it("中で仕訳を作った後に例外を投げると、仕訳・行・記録がすべて残らない", () => {
    const uow = new DrizzleInvoicingUnitOfWork(db);
    const before = {
      journals: count("journals"),
      lines: count("journal_lines"),
      audit: count("audit_log"),
    };
    expect(() =>
      uow.transaction(({ ledger: l, masters: m, invoicing }) => {
        post("invoice", { ledger: l, masters: m });
        invoicing.appendInvoicingAudit(audit());
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect({
      journals: count("journals"),
      lines: count("journal_lines"),
      audit: count("audit_log"),
    }).toEqual(before);
    expect(count("invoicing_audit_log")).toBe(0);
  });

  it("err を返したときは確定する（drizzle は err で巻き戻さない。R9）", () => {
    const uow = new DrizzleInvoicingUnitOfWork(db);
    const r = uow.transaction(({ ledger: l, masters: m }) => {
      post("invoice", { ledger: l, masters: m });
      return { ok: false as const };
    });
    expect(r.ok).toBe(false);
    expect(count("journals")).toBe(1);
  });

  it("例外がなければ仕訳と記録が残る", () => {
    const uow = new DrizzleInvoicingUnitOfWork(db);
    const entry = audit();
    uow.transaction(({ ledger: l, masters: m, invoicing }) => {
      post("invoice", { ledger: l, masters: m });
      invoicing.appendInvoicingAudit(entry);
    });
    expect(count("journals")).toBe(1);
    expect(count("invoicing_audit_log")).toBe(1);
  });
});

describe("DrizzleRecurringUnitOfWork（R9）", () => {
  it("中で仕訳を作った後に例外を投げると仕訳も記録も残らない", () => {
    const uow = new DrizzleRecurringUnitOfWork(db);
    expect(() =>
      uow.transaction(({ ledger: l, masters: m, recurring }) => {
        post("recurring", { ledger: l, masters: m });
        recurring.appendRecurringAudit(audit({ targetType: "recurring_run" }));
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(count("journals")).toBe(0);
    expect(count("invoicing_audit_log")).toBe(0);
  });

  it("例外がなければ仕訳と記録が残る", () => {
    const uow = new DrizzleRecurringUnitOfWork(db);
    uow.transaction(({ ledger: l, masters: m, recurring }) => {
      post("recurring", { ledger: l, masters: m });
      recurring.appendRecurringAudit(audit({ targetType: "recurring_run" }));
    });
    expect(count("journals")).toBe(1);
    expect(count("invoicing_audit_log")).toBe(1);
  });
});

describe("originOfJournal（H:§6.1）", () => {
  it("請求・入金・定期仕訳の仕訳（取消の仕訳を含む）から起点を引き、無関係の仕訳は null", () => {
    const s = seedRows();
    const store = new DrizzleInvoicingStore(db);
    const invoice = { kind: "invoice", invoiceId: s.invoiceId, invoiceNo: "20261031-001" };
    const payment = {
      kind: "payment",
      invoiceId: s.invoiceId,
      invoiceNo: "20261031-001",
      paymentId: s.paymentId,
    };
    expect(store.originOfJournal(s.invoiceJournal)).toEqual(invoice);
    expect(store.originOfJournal(s.voidJournal)).toEqual(invoice);
    expect(store.originOfJournal(s.paymentJournal)).toEqual(payment);
    expect(store.originOfJournal(s.paymentVoidJournal)).toEqual(payment);
    expect(store.originOfJournal(s.recurringJournal)).toEqual({
      kind: "recurring",
      recurringId: s.recurringId,
      name: "家賃",
      targetMonth: "2026-10",
    });
    expect(store.originOfJournal(post("manual"))).toBeNull();
    expect(store.originOfJournal(randomUUIDv7())).toBeNull();
  });
});

describe("appendInvoicingAudit・appendRecurringAudit（R23）", () => {
  it("同じ invoicing_audit_log に追記され、全項目が往復する", () => {
    const a = audit({
      reason: "理由",
      beforeJson: '{"a":1}',
      afterJson: '{"a":2}',
      action: "update",
    });
    const b = audit({ targetType: "recurring_run", action: "skip", reason: "不要" });
    new DrizzleInvoicingStore(db).appendInvoicingAudit(a);
    new DrizzleRecurringStore(db).appendRecurringAudit(b);
    const rows = db.$client
      .prepare(
        `SELECT id, occurred_at AS occurredAt, target_type AS targetType, target_id AS targetId, action,
                reason, before_json AS beforeJson, after_json AS afterJson
         FROM invoicing_audit_log ORDER BY rowid`,
      )
      .all();
    expect(rows).toEqual([a, b]);
  });
});
