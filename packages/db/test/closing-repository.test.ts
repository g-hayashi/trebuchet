import { randomUUIDv7 } from "node:crypto";
import {
  type AdjustmentRef,
  type ClosingAuditEntry,
  type ClosingNote,
  type ClosingUnitOfWork,
  type DeductionAnswers,
  type FiledDocument,
  type FixedAsset,
  type HomeUseAllocation,
  type JournalDraft,
  type NewJournal,
  ok,
  type RentDetail,
  TAX_PARAMETERS,
  type TaxReturnMemo,
  validateJournal,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClosingUnitOfWork, DrizzleClosingStore } from "../src/closing-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { accountIdOf, createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let store: DrizzleClosingStore;
let uow: ClosingUnitOfWork;

const clock = { now: () => "2026-10-19T09:00:00.000Z" };
const NOW = clock.now();

beforeEach(() => {
  tmp = useTempDataDir("closing-repo");
  db = openTenant(createTestEntity({ firstFiscalYear: 2025 }).id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  store = new DrizzleClosingStore(db);
  uow = createClosingUnitOfWork(db);
});
afterEach(() => tmp.cleanup());

const accountId = (name: string) => accountIdOf(masters, name);

const allocationOf = (overrides: Partial<HomeUseAllocation> = {}): HomeUseAllocation => ({
  id: randomUUIDv7(),
  fiscalYear: 2025,
  accountId: accountId("地代家賃"),
  subAccountId: null,
  businessRatio: 5000,
  basis: "床面積比",
  changeReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const assetOf = (overrides: Partial<FixedAsset> = {}): FixedAsset => ({
  id: randomUUIDv7(),
  name: "ノートPC",
  quantity: "1",
  acquiredOn: "2025-05-01",
  acquisitionCost: 200_000,
  method: "small_asset_28_2",
  usefulLifeYears: null,
  inServiceOn: null,
  priorAccumulated: 0,
  priorThroughYear: null,
  businessRatio: 10000,
  assetAccountId: accountId("工具器具備品"),
  linkedJournalId: null,
  note: null,
  disposedOn: null,
  disposalKind: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

function newJournal(draft: JournalDraft, journalNo: number): NewJournal {
  const valid = validateJournal(draft, {
    accounts: masters.listAccounts(),
    subAccounts: masters.listSubAccounts(),
    partners: masters.listPartners(),
    tags: masters.listTags(),
    periods: masters.listFiscalPeriods(),
    taxSettings: masters.listTaxSettings(),
    taxRates: masters.listTaxRates(),
  });
  if (!valid.ok) throw new Error(JSON.stringify(valid.error));
  return {
    ...valid.value,
    id: randomUUIDv7(),
    journalNo,
    createdAt: NOW,
    lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
    source: "manual",
  };
}

const adjustment = (): JournalDraft => ({
  date: "2025-12-31",
  lines: [
    { side: "debit", accountId: accountId("事業主貸"), amount: 50_000 },
    { side: "credit", accountId: accountId("地代家賃"), amount: 50_000 },
  ],
});

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("DrizzleClosingStore（T008）", () => {
  it("listTaxParameters はマイグレーションの投入値（TAX_PARAMETERS）を返す", () => {
    const key = (r: { key: string; effectiveFrom: string }) => `${r.key}@${r.effectiveFrom}`;
    const sorted = <T extends { key: string; effectiveFrom: string }>(xs: readonly T[]) =>
      [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sorted(store.listTaxParameters())).toEqual(sorted(TAX_PARAMETERS));
  });

  it("家事按分: 往復、同じ id の upsert は更新、年度で絞る", () => {
    const a = allocationOf();
    store.upsertHomeUseAllocation(a);
    expect(store.listHomeUseAllocations(2025)).toEqual([a]);
    expect(store.listHomeUseAllocations(2024)).toEqual([]);
    const changed = { ...a, businessRatio: 3000, changeReason: "面積が変わった", updatedAt: "x" };
    store.upsertHomeUseAllocation(changed);
    expect(store.listHomeUseAllocations(2025)).toEqual([changed]);
  });

  it("家事按分: 別の id で同じ (年度, 科目, 補助科目なし) は拒否される", () => {
    store.upsertHomeUseAllocation(allocationOf());
    expect(() => store.upsertHomeUseAllocation(allocationOf())).toThrow(/UNIQUE/);
    expect(store.listHomeUseAllocations(2025)).toHaveLength(1);
  });

  it("地代家賃の内訳: 往復、sortOrder の順、replace は同じ年度の行だけ置き換える", () => {
    const row = (sortOrder: number, fiscalYear = 2025): RentDetail => ({
      id: randomUUIDv7(),
      fiscalYear,
      payee: `大家${sortOrder}`,
      property: "事務所",
      annualRent: 120_000,
      deductibleAmount: 60_000,
      sortOrder,
    });
    const other = row(1, 2024);
    store.replaceRentDetails(2024, [other]);
    const [r2, r1] = [row(2), row(1)];
    store.replaceRentDetails(2025, [r2, r1]);
    expect(store.listRentDetails(2025)).toEqual([r1, r2]);
    const r3 = row(3);
    store.replaceRentDetails(2025, [r3]);
    expect(store.listRentDetails(2025)).toEqual([r3]);
    expect(store.listRentDetails(2024)).toEqual([other]);
    store.replaceRentDetails(2025, []);
    expect(store.listRentDetails(2025)).toEqual([]);
  });

  it("固定資産: 往復、upsert は更新（除却）、取得日の順", () => {
    const later = assetOf({ acquiredOn: "2025-09-01", name: "後" });
    const first = assetOf({ acquiredOn: "2025-02-01", name: "先" });
    store.upsertFixedAsset(later);
    store.upsertFixedAsset(first);
    expect(store.listFixedAssets()).toEqual([first, later]);
    const disposed = {
      ...first,
      disposedOn: "2025-12-01",
      disposalKind: "scrap" as const,
      updatedAt: "y",
    };
    store.upsertFixedAsset(disposed);
    expect(store.listFixedAssets()).toEqual([disposed, later]);
  });

  it("決算整理の仕訳の出所: 往復、年度で絞る、仕訳がなければ拒否、同じ仕訳は二重に登録できない", () => {
    const allocation = allocationOf();
    store.upsertHomeUseAllocation(allocation);
    const journal = ledger.insertJournal(newJournal(adjustment(), ledger.nextJournalNo()));
    const ref: AdjustmentRef = {
      journalId: journal.id,
      kind: "home_use",
      allocationId: allocation.id,
      assetId: null,
      deferredAssetId: null,
      fiscalYear: 2025,
    };
    store.insertAdjustmentRef(ref);
    expect(store.listAdjustmentRefs(2025)).toEqual([ref]);
    expect(store.listAdjustmentRefs(2024)).toEqual([]);
    expect(() => store.insertAdjustmentRef(ref)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => store.insertAdjustmentRef({ ...ref, journalId: randomUUIDv7() })).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("控除の要件の回答: なければ undefined、往復、upsert で更新", () => {
    expect(store.getDeductionAnswers(2025)).toBeUndefined();
    const answers: DeductionAnswers = {
      fiscalYear: 2025,
      doubleEntry: true,
      statementsAttached: true,
      filedOnTime: false,
      eTax: true,
      electronicBooks: false,
      updatedAt: NOW,
    };
    store.upsertDeductionAnswers(answers);
    expect(store.getDeductionAnswers(2025)).toEqual(answers);
    const changed = { ...answers, filedOnTime: true, electronicBooks: true };
    store.upsertDeductionAnswers(changed);
    expect(store.getDeductionAnswers(2025)).toEqual(changed);
    expect(store.getDeductionAnswers(2024)).toBeUndefined();
  });

  it("決算のメモ: 往復、(年度, 種別) ごとに1行、upsert で本文を更新", () => {
    const note = (kind: ClosingNote["kind"], body: string): ClosingNote => ({
      fiscalYear: 2025,
      kind,
      body,
      updatedAt: NOW,
    });
    store.upsertClosingNote(note("special_circumstances", "A"));
    store.upsertClosingNote(note("opening_difference", "B"));
    store.upsertClosingNote(note("special_circumstances", "A2"));
    const byKind = (xs: ClosingNote[]) => [...xs].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(byKind(store.listClosingNotes(2025))).toEqual([
      note("opening_difference", "B"),
      note("special_circumstances", "A2"),
    ]);
    expect(store.listClosingNotes(2024)).toEqual([]);
  });

  it("事業所得以外の控え: 往復、更新、削除", () => {
    const memo: TaxReturnMemo = {
      id: randomUUIDv7(),
      fiscalYear: 2025,
      kind: "salary",
      label: null,
      amount: 3_000_000,
      filePath: "/Users/x/源泉徴収票.pdf",
      memo: "他社の給与",
    };
    const nullable: TaxReturnMemo = {
      id: randomUUIDv7(),
      fiscalYear: 2025,
      kind: "other",
      label: "ふるさと納税",
      amount: null,
      filePath: null,
      memo: null,
    };
    store.upsertTaxReturnMemo(memo);
    store.upsertTaxReturnMemo(nullable);
    expect(store.listTaxReturnMemos(2025)).toEqual([memo, nullable]);
    const changed = { ...memo, amount: 3_100_000 };
    store.upsertTaxReturnMemo(changed);
    expect(store.listTaxReturnMemos(2025)).toEqual([changed, nullable]);
    store.deleteTaxReturnMemo(memo.id);
    expect(store.listTaxReturnMemos(2025)).toEqual([nullable]);
    expect(store.listTaxReturnMemos(2024)).toEqual([]);
  });

  it("提出書類の記録: 往復、更新、削除", () => {
    const doc: FiledDocument = {
      id: randomUUIDv7(),
      fiscalYear: 2025,
      kind: "blue_return",
      filePath: "/Users/x/青色申告決算書.pdf",
      filedOn: null,
      memo: null,
    };
    store.upsertFiledDocument(doc);
    expect(store.listFiledDocuments(2025)).toEqual([doc]);
    const changed = { ...doc, filedOn: "2026-03-10", memo: "e-Tax" };
    store.upsertFiledDocument(changed);
    expect(store.listFiledDocuments(2025)).toEqual([changed]);
    store.deleteFiledDocument(doc.id);
    expect(store.listFiledDocuments(2025)).toEqual([]);
  });

  it("決算の設定の変更履歴: 追記でき、更新・削除はトリガーで拒否される", () => {
    const entry: ClosingAuditEntry = {
      id: randomUUIDv7(),
      occurredAt: NOW,
      targetType: "fixed_asset",
      targetId: "x",
      action: "create",
      reason: null,
      beforeJson: null,
      afterJson: '{"a":1}',
    };
    store.appendClosingAudit(entry);
    expect(db.$client.prepare("SELECT * FROM closing_audit_log").all()).toHaveLength(1);
    expect(() => db.$client.prepare("DELETE FROM closing_audit_log").run()).toThrow(/append-only/);
  });
});

describe("createClosingUnitOfWork（T008、research R4）", () => {
  it("run の中で、仕訳・マスタ・決算の記録を同じ接続で読み書きできる", () => {
    const allocation = allocationOf();
    uow.run(({ ledger: journals, masters: m, closing }) => {
      closing.upsertHomeUseAllocation(allocation);
      const journal = journals.insertJournal(newJournal(adjustment(), journals.nextJournalNo()));
      closing.insertAdjustmentRef({
        journalId: journal.id,
        kind: "home_use",
        allocationId: allocation.id,
        assetId: null,
        deferredAssetId: null,
        fiscalYear: 2025,
      });
      expect(m.listAccounts().length).toBeGreaterThan(0);
      expect(closing.listAdjustmentRefs(2025)).toHaveLength(1);
      return ok(null);
    });
    expect(count("journals")).toBe(1);
    expect(count("adjustment_journal_refs")).toBe(1);
    expect(store.listHomeUseAllocations(2025)).toEqual([allocation]);
  });

  it("run の中の例外で、仕訳と adjustment_journal_refs が両方とも残らない", () => {
    const allocation = allocationOf();
    store.upsertHomeUseAllocation(allocation);
    expect(() =>
      uow.run(({ ledger: journals, closing }) => {
        const journal = journals.insertJournal(newJournal(adjustment(), journals.nextJournalNo()));
        closing.insertAdjustmentRef({
          journalId: journal.id,
          kind: "home_use",
          allocationId: allocation.id,
          assetId: null,
          deferredAssetId: null,
          fiscalYear: 2025,
        });
        closing.appendClosingAudit({
          id: randomUUIDv7(),
          occurredAt: NOW,
          targetType: "home_use_allocation",
          targetId: allocation.id,
          action: "update",
          reason: null,
          beforeJson: null,
          afterJson: null,
        });
        expect(count("journals")).toBe(1);
        expect(count("adjustment_journal_refs")).toBe(1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count("journals")).toBe(0);
    expect(count("journal_lines")).toBe(0);
    expect(count("adjustment_journal_refs")).toBe(0);
    expect(count("closing_audit_log")).toBe(0);
    // トランザクションの前の書き込みは残る
    expect(store.listHomeUseAllocations(2025)).toEqual([allocation]);
  });
});
