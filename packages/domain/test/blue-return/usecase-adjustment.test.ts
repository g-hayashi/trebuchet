import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import { TAX_RATES } from "../../src/seed/tax-rates.ts";
import {
  commitAdjustment,
  getAdjustmentProposals,
  getBlueReturn,
  getRentDetails,
  listHomeUseAllocations,
  saveHomeUseAllocation,
  saveRentDetails,
} from "../../src/usecases/blue-return.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { FakeClosingUnitOfWork } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

let fx: ReturnType<typeof setupLedger>;
let uow: FakeClosingUnitOfWork;

beforeEach(() => {
  fx = setupLedger();
  uow = new FakeClosingUnitOfWork(fx.ledger, fx.masters);
  uow.closing.taxParameters = [...TAX_PARAMETERS];
});

const reports = () => new InMemoryReportRepository(fx.ledger, fx.masters);
const settingsDeps = () => ({
  masters: fx.masters,
  closing: uow.closing,
  ids: fx.ids,
  clock: fx.clock,
});
const readDeps = () => ({ ...settingsDeps(), reports: reports() });
const commitDeps = () => ({ uow, reports: reports(), ids: fx.ids, clock: fx.clock });

/** 地代家賃を現金で払う（2025 年度） */
const payRent = (amount: number, date = "2025-06-30") =>
  fx.create({
    date,
    memo: "家賃",
    lines: [fx.line("debit", "地代家賃", amount), fx.line("credit", "現金", amount)],
  });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const saveRent = (businessRatio = 3000, fiscalYear = 2025, changeReason?: string) =>
  unwrap(
    saveHomeUseAllocation(settingsDeps(), {
      fiscalYear,
      accountId: fx.accountId("地代家賃"),
      businessRatio,
      basis: "床面積 15㎡／50㎡",
      ...(changeReason === undefined ? {} : { changeReason }),
    }),
  );

const proposals = (fiscalYear = 2025) => unwrap(getAdjustmentProposals(readDeps(), { fiscalYear }));

const snapshot = () =>
  structuredClone({
    ledger: fx.ledger.state,
    closing: uow.closing.state,
    masters: fx.masters.state,
  });

describe("saveHomeUseAllocation（FR-012〜013）", () => {
  it("登録して closing_audit_log に home_use_allocation（create・update）を残す。更新は同じ ID", () => {
    const created = saveRent(3000);
    expect(created).toMatchObject({ fiscalYear: 2025, businessRatio: 3000, subAccountId: null });
    const updated = saveRent(3500);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(uow.closing.listHomeUseAllocations(2025)).toEqual([updated]);
    expect(uow.closing.audits.map((a) => [a.targetType, a.targetId, a.action])).toEqual([
      ["home_use_allocation", created.id, "create"],
      ["home_use_allocation", created.id, "update"],
    ]);
    const [, second] = uow.closing.audits;
    expect(JSON.parse(second?.beforeJson ?? "null").businessRatio).toBe(3000);
    expect(JSON.parse(second?.afterJson ?? "null").businessRatio).toBe(3500);
  });

  it("根拠が空なら HOME_USE_BASIS_REQUIRED で何も保存しない（シナリオ2）", () => {
    const r = saveHomeUseAllocation(settingsDeps(), {
      fiscalYear: 2025,
      accountId: fx.accountId("地代家賃"),
      businessRatio: 3000,
      basis: " ",
    });
    expect(!r.ok && r.error.code).toBe("HOME_USE_BASIS_REQUIRED");
    expect(uow.closing.listHomeUseAllocations(2025)).toEqual([]);
    expect(uow.closing.audits).toEqual([]);
  });

  it("費用でない科目は HOME_USE_ACCOUNT_INVALID", () => {
    const r = saveHomeUseAllocation(settingsDeps(), {
      fiscalYear: 2025,
      accountId: fx.accountId("現金"),
      businessRatio: 3000,
      basis: "根拠",
    });
    expect(!r.ok && r.error.code).toBe("HOME_USE_ACCOUNT_INVALID");
  });

  it("前の年度と割合が違えば理由が必須。理由は履歴に残る（シナリオ3）", () => {
    saveRent(3000, 2025);
    const r = saveHomeUseAllocation(settingsDeps(), {
      fiscalYear: 2026,
      accountId: fx.accountId("地代家賃"),
      businessRatio: 4000,
      basis: "床面積 20㎡／50㎡",
    });
    expect(!r.ok && r.error.code).toBe("HOME_USE_CHANGE_REASON_REQUIRED");
    const saved = saveRent(4000, 2026, "事務所の拡張");
    expect(saved.changeReason).toBe("事務所の拡張");
    expect(uow.closing.audits.at(-1)).toMatchObject({
      targetType: "home_use_allocation",
      action: "create",
      reason: "事務所の拡張",
    });
  });

  it("締め済みの年度でも登録できる（登録そのものは帳簿ではない）", () => {
    fx.closeYear(2025);
    expect(saveRent(3000).fiscalYear).toBe(2025);
  });
});

describe("listHomeUseAllocations（GET home-use）", () => {
  it("年度の登録と、前の年度の登録（previousYear）を返す。登録がなければどちらも空", () => {
    expect(unwrap(listHomeUseAllocations(settingsDeps(), { fiscalYear: 2026 }))).toEqual({
      allocations: [],
      previousYear: [],
    });
    const prev = saveRent(3000, 2025);
    const current = saveRent(3500, 2026, "在宅の日が増えた");
    expect(unwrap(listHomeUseAllocations(settingsDeps(), { fiscalYear: 2026 }))).toEqual({
      allocations: [current],
      previousYear: [prev],
    });
  });

  it("会計期間のない年度は VALIDATION", () => {
    const r = listHomeUseAllocations(settingsDeps(), { fiscalYear: 1999 });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });
});

describe("getRentDetails（GET rent-details）", () => {
  it("年度の内訳を並び順どおりに返す。法人・会計期間のない年度は失敗", () => {
    expect(unwrap(getRentDetails(settingsDeps(), { fiscalYear: 2025 }))).toEqual([]);
    const saved = unwrap(
      saveRentDetails(settingsDeps(), {
        fiscalYear: 2025,
        rows: [
          { payee: "大家A", property: "事務所", annualRent: 100, deductibleAmount: 50 },
          { payee: "大家B", property: "駐車場", annualRent: 200, deductibleAmount: 200 },
        ],
      }),
    );
    expect(unwrap(getRentDetails(settingsDeps(), { fiscalYear: 2025 }))).toEqual(saved);
    const r = getRentDetails(settingsDeps(), { fiscalYear: 1999 });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });
});

describe("saveRentDetails（FR-017）", () => {
  const row = (payee: string, annualRent: number, deductibleAmount: number) => ({
    payee,
    property: "自宅（東京都）",
    annualRent,
    deductibleAmount,
  });

  it("全件を置き換え、並び順を振り、rent_detail の履歴を残す", () => {
    const first = unwrap(
      saveRentDetails(settingsDeps(), {
        fiscalYear: 2025,
        rows: [row("大家A", 1_200_000, 360_000), row("駐車場B", 120_000, 120_000)],
      }),
    );
    expect(first.map((r) => [r.payee, r.sortOrder, r.fiscalYear])).toEqual([
      ["大家A", 0, 2025],
      ["駐車場B", 1, 2025],
    ]);
    const second = unwrap(
      saveRentDetails(settingsDeps(), {
        fiscalYear: 2025,
        rows: [row("大家A", 1_200_000, 400_000)],
      }),
    );
    expect(uow.closing.listRentDetails(2025)).toEqual(second);
    expect(uow.closing.audits.map((a) => [a.targetType, a.targetId, a.action])).toEqual([
      ["rent_detail", "2025", "create"],
      ["rent_detail", "2025", "update"],
    ]);
    unwrap(saveRentDetails(settingsDeps(), { fiscalYear: 2025, rows: [] }));
    expect(uow.closing.audits.at(-1)?.action).toBe("delete");
  });

  it("必要経費算入額が賃借料を超える行、空の支払先は VALIDATION で何も保存しない", () => {
    for (const bad of [row("大家A", 100, 101), row(" ", 100, 100), row("大家A", -1, 0)]) {
      const r = saveRentDetails(settingsDeps(), { fiscalYear: 2025, rows: [bad] });
      expect(!r.ok && r.error.code).toBe("VALIDATION");
    }
    expect(uow.closing.listRentDetails(2025)).toEqual([]);
    expect(uow.closing.audits).toEqual([]);
  });
});

describe("getAdjustmentProposals・commitAdjustment（FR-014〜016、R4）", () => {
  it("シナリオ1・4: 案を確定すると仕訳と参照を登録し、地代家賃の欄は事業分、案はなくなる", () => {
    payRent(1_200_000);
    const allocation = saveRent(3000);
    const [proposal, ...rest] = proposals();
    expect(rest).toEqual([]);
    expect(proposal?.breakdown).toEqual({
      bookAmount: 1_200_000,
      ratio: 3000,
      business: 360_000,
      home: 840_000,
    });
    // 振替の前は決算書が警告する（差額は案と同じ）
    const before = unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
    expect(
      before.warnings
        .filter((w) => w.code === "HOME_USE_ADJUSTMENT_STALE")
        .map((w) => w.details?.difference),
    ).toEqual([840_000]);

    const committed = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 840_000 },
      }),
    );
    expect(committed.journal).toMatchObject({ date: "2025-12-31", source: "manual" });
    expect(committed.journal.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", fx.accountId("事業主貸"), 840_000],
      ["credit", fx.accountId("地代家賃"), 840_000],
    ]);
    expect(committed.ref).toEqual({
      journalId: committed.journal.id,
      kind: "home_use",
      allocationId: allocation.id,
      assetId: null,
      fiscalYear: 2025,
    });
    expect(uow.closing.listAdjustmentRefs(2025)).toEqual([committed.ref]);
    expect(proposals()).toEqual([]);

    const blue = unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
    expect(blue.page1.lines.find((l) => l.no === 23)?.amount).toBe(360_000);
    expect(blue.warnings.filter((w) => w.code === "HOME_USE_ADJUSTMENT_STALE")).toEqual([]);
  });

  it("地代家賃の内訳を保存すると決算書の2ページに載り、欄23と合えば警告しない", () => {
    payRent(1_200_000);
    const allocation = saveRent(3000);
    unwrap(
      saveRentDetails(settingsDeps(), {
        fiscalYear: 2025,
        rows: [
          { payee: "大家A", property: "事務所", annualRent: 1_200_000, deductibleAmount: 360_000 },
        ],
      }),
    );
    const mismatched = unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
    expect(mismatched.page2.rentDetails).toHaveLength(1);
    // 欄23 は振替の前で 1,200,000
    expect(mismatched.warnings.map((w) => w.code)).toContain("RENT_DETAILS_MISMATCH");
    unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 840_000 },
      }),
    );
    const matched = unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
    expect(matched.warnings.map((w) => w.code)).not.toContain("RENT_DETAILS_MISMATCH");
  });

  it("課税期間の帳簿でも、振替の仕訳の両方の行の税区分は対象外（仕入にしない）", () => {
    fx.masters.state.taxRates = [...TAX_RATES];
    fx.masters.replaceTaxSettings([
      {
        id: "ts-1",
        effectiveFrom: "2025-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const rent = payRent(1_200_000);
    // 課税期間の費用の行は既定で仕入 10%（振替の対象外とは区別される）
    expect(rent.lines.find((l) => l.accountId === fx.accountId("地代家賃"))?.taxCategory).toBe(
      "PURCHASE_10",
    );
    const allocation = saveRent(3000);
    const committed = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 840_000 },
      }),
    );
    expect(committed.journal.lines.map((l) => l.taxCategory)).toEqual([
      "OUT_OF_SCOPE",
      "OUT_OF_SCOPE",
    ]);
    expect(committed.journal.lines.map((l) => l.taxAmount)).toEqual([0, 0]);
  });

  it("費用の仕訳を取り消した後は逆向きの案を確定でき、差額 0 に戻る", () => {
    payRent(1_200_000);
    const extra = payRent(100_000);
    const allocation = saveRent(3000);
    unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 910_000 },
      }),
    );
    unwrap(voidJournal(fx.deps, extra.id, { reason: "二重計上", version: extra.version }));
    const [back] = proposals();
    expect(back?.journal.lines).toEqual([
      {
        side: "debit",
        accountId: fx.accountId("地代家賃"),
        amount: 70_000,
        taxCategory: "OUT_OF_SCOPE",
      },
      {
        side: "credit",
        accountId: fx.accountId("事業主貸"),
        amount: 70_000,
        taxCategory: "OUT_OF_SCOPE",
      },
    ]);
    unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 70_000 },
      }),
    );
    expect(proposals()).toEqual([]);
    expect(uow.closing.listAdjustmentRefs(2025)).toHaveLength(2);
  });

  it("画面が見た金額と作り直した案が違えば ADJUSTMENT_CHANGED（details.proposal）で何も書かない", () => {
    payRent(1_200_000);
    const allocation = saveRent(3000);
    payRent(100_000);
    const before = snapshot();
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "home_use",
      sourceId: allocation.id,
      expected: { amount: 840_000 },
    });
    expect(!r.ok && r.error.code).toBe("ADJUSTMENT_CHANGED");
    const proposal = !r.ok ? (r.error.details?.proposal as { breakdown: { home: number } }) : null;
    expect(proposal?.breakdown.home).toBe(910_000);
    expect(snapshot()).toEqual(before);
  });

  it("作り直した案がなければ ADJUSTMENT_NOT_NEEDED", () => {
    const allocation = saveRent(3000);
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "home_use",
      sourceId: allocation.id,
      expected: { amount: 1 },
    });
    expect(!r.ok && r.error.code).toBe("ADJUSTMENT_NOT_NEEDED");
    expect(!r.ok && r.error.details?.reason).toBe("BOOK_AMOUNT_NOT_POSITIVE");
  });

  it("シナリオ7: 締め済みの年度は PERIOD_CLOSED（締めの解除を案内）で何も書かない", () => {
    payRent(1_200_000);
    const allocation = saveRent(3000);
    fx.closeYear(2025);
    const before = snapshot();
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "home_use",
      sourceId: allocation.id,
      expected: { amount: 840_000 },
    });
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
    expect(!r.ok && r.error.details?.suggest).toBe("reopen_period");
    expect(snapshot()).toEqual(before);
  });

  it("参照の登録が途中で失敗すると、仕訳も監査ログも残らない（1トランザクション）", () => {
    payRent(1_200_000);
    const allocation = saveRent(3000);
    const before = snapshot();
    vi.spyOn(uow.closing, "insertAdjustmentRef").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    expect(() =>
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "home_use",
        sourceId: allocation.id,
        expected: { amount: 840_000 },
      }),
    ).toThrow("disk I/O error");
    expect(snapshot()).toEqual(before);
  });

  it("按分の登録が見つからなければ VALIDATION、depreciation はまだ扱わない", () => {
    const missing = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "home_use",
      sourceId: "missing",
      expected: { amount: 1 },
    });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const dep = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: "asset-1",
      expected: { amount: 1 },
    });
    expect(!dep.ok && dep.error.code).toBe("VALIDATION");
  });

  it("他の年度の按分の登録は使わない", () => {
    payRent(1_200_000);
    const other = saveRent(3000, 2026);
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "home_use",
      sourceId: other.id,
      expected: { amount: 840_000 },
    });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });
});
