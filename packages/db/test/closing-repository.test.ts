import { randomUUIDv7 } from "node:crypto";
import {
  type AdjustmentRef,
  type ClosingAuditEntry,
  type ClosingNote,
  type ClosingUnitOfWork,
  type DeductionAnswers,
  type DeferredAmortization,
  type DeferredAsset,
  type FiledDocument,
  type FixedAsset,
  type HomeUseAllocation,
  type JournalDraft,
  type NewJournal,
  ok,
  type RentDetail,
  STRAIGHT_LINE_RATES,
  type StraightLineRate,
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

describe("DrizzleClosingStore（009 T007）", () => {
  const deferredOf = (overrides: Partial<DeferredAsset> = {}): DeferredAsset => ({
    id: randomUUIDv7(),
    name: "開業費",
    totalAmount: 300_000,
    openedOn: "2025-04-01",
    priorAccumulated: 0,
    priorThroughYear: null,
    accountId: accountId("開業費"),
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

  const addPeriods = () => {
    for (const year of [2026, 2027]) {
      masters.insertFiscalPeriod({
        id: randomUUIDv7(),
        fiscalYear: year,
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
        status: "open",
        closedAt: null,
      });
    }
  };

  const adjustmentOn = (date: string): JournalDraft => ({
    date,
    lines: [
      { side: "debit", accountId: accountId("事業主貸"), amount: 1_000 },
      { side: "credit", accountId: accountId("地代家賃"), amount: 1_000 },
    ],
  });

  const insertJournal = (date: string) =>
    ledger.insertJournal(newJournal(adjustmentOn(date), ledger.nextJournalNo()));

  it("listStraightLineRates は投入した償却率（STRAIGHT_LINE_RATES）と一致する", () => {
    const key = (r: StraightLineRate) => `${r.usefulLifeYears}@${r.effectiveFrom}`;
    const sorted = (xs: readonly StraightLineRate[]) =>
      [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    const rows = store.listStraightLineRates();
    expect(rows).toHaveLength(STRAIGHT_LINE_RATES.length);
    expect(sorted(rows)).toEqual(sorted(STRAIGHT_LINE_RATES));
  });

  it("listTaxParameters は 009 の 4 行を含む", () => {
    const keys = store.listTaxParameters().map((r) => r.key);
    for (const k of [
      "LUMP_SUM_COST_MIN",
      "LUMP_SUM_COST_MAX",
      "LUMP_SUM_YEARS",
      "OPENING_COST_AMORTIZATION_MONTHS",
    ]) {
      expect(keys).toContain(k);
    }
  });

  it("listTaxParameters は 010 の 4 行（証憑の電子保存。出典の URL つき）を返す。4 key が入ることの確認はここだけ", () => {
    const rows = store.listTaxParameters().filter((r) => r.key.startsWith("RECEIPT_"));
    expect(rows.map((r) => [r.key, r.value, r.effectiveFrom, r.effectiveTo]).sort()).toEqual([
      ["RECEIPT_INPUT_CYCLE_MONTHS", 2, "2024-01-01", null],
      ["RECEIPT_INPUT_GRACE_BUSINESS_DAYS", 7, "2024-01-01", null],
      ["RECEIPT_SCAN_MIN_LONG_PX", 2338, "2024-01-01", null],
      ["RECEIPT_SCAN_MIN_SHORT_PX", 1654, "2024-01-01", null],
    ]);
    for (const r of rows) {
      expect(r.sourceUrl).toBe(
        "https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf",
      );
    }
  });

  it("固定資産: 定額法・一括償却の新しい列（供用日・前年までの累計・除却の種類）が往復する", () => {
    const straight = assetOf({
      name: "定額法",
      method: "straight_line",
      usefulLifeYears: 4,
      acquiredOn: "2025-03-10",
      inServiceOn: "2025-04-01",
      acquisitionCost: 400_000,
      priorAccumulated: 100_000,
      priorThroughYear: 2025,
      disposedOn: "2027-06-30",
      disposalKind: "sale",
    });
    const lump = assetOf({
      name: "一括",
      method: "lump_sum",
      acquiredOn: "2025-06-01",
      acquisitionCost: 150_000,
    });
    store.upsertFixedAsset(straight);
    store.upsertFixedAsset(lump);
    expect(store.listFixedAssets()).toEqual([straight, lump]);
    const changed = { ...straight, disposalKind: "scrap" as const, updatedAt: "z" };
    store.upsertFixedAsset(changed);
    expect(store.listFixedAssets()).toEqual([changed, lump]);
  });

  it("固定資産: 定額法で耐用年数がない行は DB の CHECK が拒否する", () => {
    expect(() =>
      store.upsertFixedAsset(assetOf({ method: "straight_line", usefulLifeYears: null })),
    ).toThrow(/CHECK/);
  });

  it("開業費: 往復、同じ id の upsert は更新、開業日・id の順", () => {
    const later = deferredOf({ name: "後", openedOn: "2025-09-01" });
    const first = deferredOf({ name: "先", openedOn: "2025-02-01", note: "メモ" });
    store.upsertDeferredAsset(later);
    store.upsertDeferredAsset(first);
    expect(store.listDeferredAssets()).toEqual([first, later]);
    const changed = {
      ...first,
      totalAmount: 500_000,
      priorAccumulated: 100_000,
      priorThroughYear: 2025,
      note: null,
      updatedAt: "u",
    };
    store.upsertDeferredAsset(changed);
    expect(store.listDeferredAssets()).toEqual([changed, later]);
  });

  it("開業費: 累計が総額を超える行は DB の CHECK が拒否する", () => {
    expect(() =>
      store.upsertDeferredAsset(
        deferredOf({ totalAmount: 100, priorAccumulated: 101, priorThroughYear: 2025 }),
      ),
    ).toThrow(/CHECK/);
  });

  it("開業費の決定: 全年度を返し、同じ PK の upsert は更新する", () => {
    addPeriods();
    const a = deferredOf();
    const b = deferredOf({ name: "別" });
    store.upsertDeferredAsset(a);
    store.upsertDeferredAsset(b);
    const row = (d: DeferredAsset, fiscalYear: number, amount: number): DeferredAmortization => ({
      deferredAssetId: d.id,
      fiscalYear,
      amount,
      decidedAt: NOW,
      updatedAt: NOW,
    });
    const rows = [row(a, 2025, 10_000), row(a, 2026, 60_000), row(b, 2025, 0)];
    for (const r of rows) store.upsertDeferredAmortization(r);
    const byKey = (xs: DeferredAmortization[]) =>
      [...xs].sort((x, y) =>
        `${x.deferredAssetId}:${x.fiscalYear}`.localeCompare(
          `${y.deferredAssetId}:${y.fiscalYear}`,
        ),
      );
    expect(byKey(store.listDeferredAmortizations())).toEqual(byKey(rows));
    const changed = { ...row(a, 2026, 70_000), updatedAt: "later" };
    store.upsertDeferredAmortization(changed);
    const after = store.listDeferredAmortizations();
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.deferredAssetId === a.id && r.fiscalYear === 2026)).toEqual(changed);
    expect(count("deferred_amortizations")).toBe(3);
  });

  it("開業費の決定: 負の額・存在しない開業費・存在しない年度は拒否される", () => {
    const a = deferredOf();
    store.upsertDeferredAsset(a);
    const base = {
      deferredAssetId: a.id,
      fiscalYear: 2025,
      amount: 0,
      decidedAt: NOW,
      updatedAt: NOW,
    };
    expect(() => store.upsertDeferredAmortization({ ...base, amount: -1 })).toThrow(/CHECK/);
    expect(() =>
      store.upsertDeferredAmortization({ ...base, deferredAssetId: randomUUIDv7() }),
    ).toThrow(/FOREIGN KEY/);
    expect(() => store.upsertDeferredAmortization({ ...base, fiscalYear: 2031 })).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("決算整理の仕訳の出所: 開業費の参照（deferredAssetId）が往復する", () => {
    addPeriods();
    const a = deferredOf();
    store.upsertDeferredAsset(a);
    const journal = insertJournal("2025-12-31");
    const ref: AdjustmentRef = {
      journalId: journal.id,
      kind: "deferred_amortization",
      allocationId: null,
      assetId: null,
      deferredAssetId: a.id,
      fiscalYear: 2025,
    };
    store.insertAdjustmentRef(ref);
    expect(store.listAdjustmentRefs(2025)).toEqual([ref]);
    // deferred_amortization で deferredAssetId がない参照は拒否される
    const other = insertJournal("2025-12-31");
    expect(() =>
      store.insertAdjustmentRef({ ...ref, journalId: other.id, deferredAssetId: null }),
    ).toThrow(/CHECK/);
  });

  it("listAdjustmentRefsBySource: 出所ごとに全年度の参照を返し、他の出所は混ざらない", () => {
    addPeriods();
    const asset = assetOf({ method: "straight_line", usefulLifeYears: 4 });
    const otherAsset = assetOf({ method: "straight_line", usefulLifeYears: 5 });
    const deferred = deferredOf();
    store.upsertFixedAsset(asset);
    store.upsertFixedAsset(otherAsset);
    store.upsertDeferredAsset(deferred);
    const depRef = (assetId: string, year: number): AdjustmentRef => ({
      journalId: insertJournal(`${year}-12-31`).id,
      kind: "depreciation",
      allocationId: null,
      assetId,
      deferredAssetId: null,
      fiscalYear: year,
    });
    const defRef = (year: number): AdjustmentRef => ({
      journalId: insertJournal(`${year}-12-31`).id,
      kind: "deferred_amortization",
      allocationId: null,
      assetId: null,
      deferredAssetId: deferred.id,
      fiscalYear: year,
    });
    const mine = [depRef(asset.id, 2025), depRef(asset.id, 2026), depRef(asset.id, 2027)];
    const theirs = [depRef(otherAsset.id, 2025)];
    const deferredRefs = [defRef(2025), defRef(2026)];
    for (const r of [...mine, ...theirs, ...deferredRefs]) store.insertAdjustmentRef(r);
    expect(store.listAdjustmentRefsBySource({ assetId: asset.id })).toEqual(mine);
    expect(store.listAdjustmentRefsBySource({ assetId: otherAsset.id })).toEqual(theirs);
    expect(store.listAdjustmentRefsBySource({ deferredAssetId: deferred.id })).toEqual(
      deferredRefs,
    );
    expect(store.listAdjustmentRefsBySource({ assetId: randomUUIDv7() })).toEqual([]);
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
