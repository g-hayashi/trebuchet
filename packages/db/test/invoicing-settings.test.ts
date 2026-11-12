import { randomUUIDv7 } from "node:crypto";
import {
  createJournal,
  deleteBillingTerms,
  getInvoiceSettings,
  listBillingTerms,
  saveBillingTerms,
  saveInvoiceSettings,
} from "@trebuchet/domain";
import type { BillingTermsInput, InvoiceSettingsInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInvoicingUnitOfWork, DrizzleInvoicingStore } from "../src/invoicing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  NOW,
  type TempDataDir,
  testClock,
  testIds,
  useTempDataDir,
} from "../src/testing.ts";

// 005 US4: 設定・条件の保存と読み戻しの往復、条件の削除、次の通し番号の下限（R6）。
// トリガー・CHECK・UNIQUE の個別の検査は invoicing-schema.test.ts（T002）

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let deps: {
  uow: ReturnType<typeof createInvoicingUnitOfWork>;
  ids: { next(): string };
  clock: { now(): string };
};

beforeEach(() => {
  tmp = useTempDataDir("invoicing-settings");
  db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  deps = { uow: createInvoicingUnitOfWork(db), ids: testIds(), clock: testClock() };
});
afterEach(() => tmp.cleanup());

const addPartner = (name: string, isActive = true): string => {
  const id = randomUUIDv7();
  masters.insertPartner({ id, name, honorific: "御中", memo: null, isActive });
  return id;
};

const settingsInput = (over: Partial<InvoiceSettingsInput> = {}): InvoiceSettingsInput => ({
  issuerName: "山田 太郎",
  address: "東京都千代田区",
  contact: "taro@example.com",
  bankAccount: "○○銀行\n普通 1234567",
  taxDisplay: "separate",
  nextSeq: 1,
  ...over,
});

const hourly = (over: Partial<BillingTermsInput> = {}): BillingTermsInput => ({
  billingType: "hourly",
  unitPrice: 10_000,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  withholding: false,
  ...over,
});

const audits = () =>
  db.$client
    .prepare("SELECT target_type, target_id, action FROM invoicing_audit_log ORDER BY rowid")
    .all() as { target_type: string; target_id: string; action: string }[];

/** 請求書の行を直接入れる（発行のユースケースは US1 の実装で足す） */
function seedInvoice(seq: number, voided = false): void {
  const partnerId = addPartner(`取引先${seq}`);
  const journal = createJournal(
    {
      ledger: new DrizzleLedgerRepository(db),
      masters,
      ids: deps.ids,
      clock: deps.clock,
    },
    {
      date: "2026-10-31",
      lines: [
        {
          side: "debit",
          accountId: accountId("売掛金"),
          amount: 110_000,
        },
        { side: "credit", accountId: accountId("売上高"), amount: 110_000 },
      ],
    },
    { source: "invoice" },
  );
  if (!journal.ok) throw new Error(JSON.stringify(journal.error));
  db.$client
    .prepare(
      `INSERT INTO invoices (id, invoice_no, seq, partner_id, target_month, issue_date, sales_date, due_date,
         recipient_name, recipient_honorific, issuer_json, tax_display, total, journal_id, created_at,
         voided_at, void_reason)
       VALUES (?, ?, ?, ?, '2026-10', '2026-10-31', '2026-10-31', '2026-11-30',
         '株式会社A', '御中', '{}', 'inclusive_only', 110000, ?, ?, ?, ?)`,
    )
    .run(
      randomUUIDv7(),
      `20261031-${String(seq).padStart(3, "0")}`,
      seq,
      partnerId,
      journal.value.journal.id,
      NOW,
      voided ? NOW : null,
      voided ? "誤り" : null,
    );
}

const accountId = (name: string) => accountIdOf(masters, name);

describe("発行者の設定（FR-003, FR-004）", () => {
  it("行がなければ null、minimumNextSeq は 1", () => {
    expect(getInvoiceSettings(deps)).toEqual({
      ok: true,
      value: { settings: null, minimumNextSeq: 1 },
    });
  });

  it("保存と読み戻しの往復（任意の項目は null、複数行の振込先はそのまま）", () => {
    const saved = saveInvoiceSettings(deps, settingsInput({ nextSeq: 43 }));
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const read = getInvoiceSettings(deps);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.settings).toEqual({
      issuerName: "山田 太郎",
      tradeName: null,
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行\n普通 1234567",
      registrationNumber: null,
      taxDisplay: "separate",
      nextSeq: 43,
      updatedAt: NOW,
    });
    expect(read.value.minimumNextSeq).toBe(1);
  });

  it("上書きしても 1 行のまま。屋号・登録番号も往復する", () => {
    saveInvoiceSettings(deps, settingsInput());
    const r = saveInvoiceSettings(
      deps,
      settingsInput({ tradeName: "山田設計", registrationNumber: "T1234567890123", nextSeq: 9 }),
    );
    expect(r.ok).toBe(true);
    const rows = db.$client.prepare("SELECT COUNT(*) AS n FROM invoice_settings").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    const read = getInvoiceSettings(deps);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.settings).toMatchObject({
      tradeName: "山田設計",
      registrationNumber: "T1234567890123",
      nextSeq: 9,
    });
  });

  it("発行済みの最大の seq（取消を含む）から minimumNextSeq が決まり、それ以下の nextSeq は INVOICE_SEQ_TOO_LOW", () => {
    seedInvoice(1);
    seedInvoice(4, true);
    const read = getInvoiceSettings(deps);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.minimumNextSeq).toBe(5);

    const low = saveInvoiceSettings(deps, settingsInput({ nextSeq: 4 }));
    expect(low).toMatchObject({
      ok: false,
      error: { code: "INVOICE_SEQ_TOO_LOW", details: { minimum: 5 } },
    });
    expect(audits()).toHaveLength(0);

    expect(saveInvoiceSettings(deps, settingsInput({ nextSeq: 5 })).ok).toBe(true);
  });

  it("DrizzleInvoicingStore.maxInvoiceSeq: 1 件もなければ null", () => {
    expect(new DrizzleInvoicingStore(db).maxInvoiceSeq()).toBeNull();
    seedInvoice(3);
    expect(new DrizzleInvoicingStore(db).maxInvoiceSeq()).toBe(3);
  });

  it("保存の記録が invoicing_audit_log に残る", () => {
    saveInvoiceSettings(deps, settingsInput());
    saveInvoiceSettings(deps, settingsInput({ issuerName: "山田 次郎" }));
    expect(audits()).toEqual([
      { target_type: "invoice_settings", target_id: "1", action: "create" },
      { target_type: "invoice_settings", target_id: "1", action: "update" },
    ]);
  });
});

describe("請求の条件（FR-001, FR-002）", () => {
  it("型ごとの保存と読み戻しの往復", () => {
    const a = addPartner("A 商事");
    const b = addPartner("B 工業", false);
    const ra = saveBillingTerms(deps, a, hourly());
    const rb = saveBillingTerms(deps, b, {
      billingType: "monthly",
      monthlyAmount: 300_000,
      dueMonthsAfter: 0,
      dueDay: 25,
      defaultItemName: "顧問料",
      billingName: "B 工業 経理部",
      withholding: false,
    });
    if (!ra.ok || !rb.ok) throw new Error("expected ok");
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value).toEqual([
      { ...ra.value, partnerName: "A 商事", honorific: "御中", partnerActive: true },
      { ...rb.value, partnerName: "B 工業", honorific: "御中", partnerActive: false },
    ]);
    expect(rb.value).toMatchObject({
      billingType: "monthly",
      unitPrice: null,
      monthlyAmount: 300_000,
      billingName: "B 工業 経理部",
    });
  });

  it("型を切り替えて上書きすると 1 行のまま、旧型の金額は消える", () => {
    const a = addPartner("A 商事");
    saveBillingTerms(deps, a, hourly());
    const r = saveBillingTerms(deps, a, {
      billingType: "monthly",
      monthlyAmount: 100_000,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "顧問料",
      withholding: false,
    });
    expect(r).toMatchObject({ ok: true, value: { unitPrice: null, monthlyAmount: 100_000 } });
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value).toHaveLength(1);
  });

  it("条件の削除。ほかの取引先の条件は残り、記録（void）が残る", () => {
    const a = addPartner("A 商事");
    const b = addPartner("B 工業");
    saveBillingTerms(deps, a, hourly());
    saveBillingTerms(deps, b, hourly({ unitPrice: 8_000 }));
    expect(deleteBillingTerms(deps, a).ok).toBe(true);
    const list = listBillingTerms(deps);
    if (!list.ok) throw new Error("expected ok");
    expect(list.value.map((t) => t.partnerId)).toEqual([b]);
    expect(audits().at(-1)).toEqual({ target_type: "billing_terms", target_id: a, action: "void" });
    // 取引先そのものは残る
    expect(masters.listPartners().map((p) => p.id)).toContain(a);
  });

  it("存在しない取引先は VALIDATION（details.field = partnerId）で、何も書かない", () => {
    const r = saveBillingTerms(deps, randomUUIDv7(), hourly());
    expect(r).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", details: { field: "partnerId" } },
    });
    expect(audits()).toHaveLength(0);
  });
});
