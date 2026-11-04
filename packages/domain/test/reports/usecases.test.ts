import { beforeEach, describe, expect, it } from "vitest";
import { replaceOpeningBalances } from "../../src/usecases/masters.ts";
import {
  getBalanceSheet,
  getGeneralLedger,
  getJournalBook,
  getProfitAndLoss,
  getTrialBalance,
} from "../../src/usecases/reports.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "./fake-report-repository.ts";

let f: ReturnType<typeof setupLedger>;
let deps: { masters: typeof f.masters; reports: InMemoryReportRepository };

beforeEach(() => {
  f = setupLedger();
  deps = { masters: f.masters, reports: new InMemoryReportRepository(f.ledger, f.masters) };
  const opening = replaceOpeningBalances({ repo: f.masters, ids: f.ids, clock: f.clock }, 2026, [
    { accountId: f.accountId("普通預金"), side: "debit", amount: 1_000_000 },
    { accountId: f.accountId("元入金"), side: "credit", amount: 1_000_000 },
  ]);
  if (!opening.ok) throw new Error(opening.error.message);
});

describe("帳票のユースケース（US4）", () => {
  it("試算表: 会計期間の期首残高と、期首から to までの仕訳から作る。警告を添える", () => {
    f.create(f.sale(100_000, "2026-03-31"));
    f.create(f.sale(50_000, "2026-05-10"));
    const r = getTrialBalance(deps, { from: "2026-04-01", to: "2026-12-31" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ar = r.value.rows.find((x) => x.name === "売掛金");
    expect(ar).toMatchObject({ opening: 100_000, debit: 50_000, credit: 0, closing: 150_000 });
    expect(r.value.rows.find((x) => x.name === "普通預金")?.closing).toBe(1_000_000);
    expect(r.value.balanced).toBe(true);
    expect(r.value.warnings).toEqual([]);
  });

  it("from が会計期間の外なら OUT_OF_PERIOD、from と to が別の会計期間なら VALIDATION", () => {
    const out = getTrialBalance(deps, { from: "2024-01-01", to: "2024-12-31" });
    expect(!out.ok && out.error.code).toBe("OUT_OF_PERIOD");
    const across = getTrialBalance(deps, { from: "2025-06-01", to: "2026-03-31" });
    expect(!across.ok && across.error.code).toBe("VALIDATION");
  });

  it("仕訳帳は会計期間をまたいでよく、取消済みは含まない", () => {
    f.create(f.sale(1_000, "2025-12-31"));
    const voided = f.create(f.sale(2_000, "2026-01-02"));
    f.create(f.sale(3_000, "2026-01-03"));
    expect(voidJournal(f.deps, voided.id, { reason: "二重登録", version: 1 }).ok).toBe(true);
    const r = getJournalBook(deps, { from: "2025-12-01", to: "2026-01-31" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries.map((e) => e.date)).toEqual(["2025-12-31", "2026-01-03"]);
    expect(r.value.totals).toEqual({ debit: 4_000, credit: 4_000 });
  });

  it("総勘定元帳: 科目がなければ ACCOUNT_NOT_FOUND、補助科目で絞れる", () => {
    const missing = getGeneralLedger(deps, {
      from: "2026-01-01",
      to: "2026-12-31",
      accountId: "0000000a-0000-7000-8000-000000000999",
    });
    expect(!missing.ok && missing.error.code).toBe("ACCOUNT_NOT_FOUND");
    f.create(f.sale(10_000, "2026-02-01"));
    const r = getGeneralLedger(deps, {
      from: "2026-01-01",
      to: "2026-12-31",
      accountId: f.accountId("普通預金"),
    });
    expect(r.ok && r.value.broughtForward).toBe(1_000_000);
    expect(r.ok && r.value.subAccount).toBeNull();
  });

  it("損益計算書の前年比較: 1 年前の同じ範囲と比べる", () => {
    f.create(f.sale(80_000, "2025-04-15"));
    f.create(f.sale(100_000, "2026-04-15"));
    const r = getProfitAndLoss(deps, {
      from: "2026-01-01",
      to: "2026-12-31",
      compare: "previous-year",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.previous).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(r.value.netIncome).toEqual({ amount: 100_000, previous: 80_000, change: 20_000 });
  });

  it("前年の会計期間がなければ、前年の値は 0 として比べる", () => {
    f.create(f.sale(80_000, "2025-04-15"));
    const r = getProfitAndLoss(deps, {
      from: "2025-01-01",
      to: "2025-12-31",
      compare: "previous-year",
    });
    expect(r.ok && r.value.netIncome).toEqual({ amount: 80_000, previous: 0, change: 80_000 });
    expect(r.ok && r.value.previousHasData).toBe(false);
  });

  it("FR-041: 損益計算書の previousHasData は、前年の同じ範囲に取消を除く仕訳の行があるか", () => {
    const range = { from: "2026-01-01", to: "2026-12-31", compare: "previous-year" as const };
    f.create(f.sale(100_000, "2026-04-15"));
    const none = getProfitAndLoss(deps, range);
    expect(none.ok && none.value.previousHasData).toBe(false);
    // 当年の仕訳は前年の範囲の外なので数えない
    expect(getProfitAndLoss(deps, range)).toMatchObject({ value: { previousHasData: false } });
    // 取消済みの仕訳は数えない
    const voided = f.create(f.sale(2_000, "2025-04-15"));
    expect(voidJournal(f.deps, voided.id, { reason: "二重登録", version: 1 }).ok).toBe(true);
    expect(getProfitAndLoss(deps, range)).toMatchObject({ value: { previousHasData: false } });
    f.create(f.sale(80_000, "2025-04-15"));
    expect(getProfitAndLoss(deps, range)).toMatchObject({ value: { previousHasData: true } });
    // 比較しないときは付けない
    const plain = getProfitAndLoss(deps, { from: "2026-01-01", to: "2026-12-31" });
    expect(plain.ok && "previousHasData" in plain.value).toBe(false);
  });

  it("FR-041: 貸借対照表の previousHasData は、前年の会計期間があるか", () => {
    const withPrev = getBalanceSheet(deps, { asOf: "2026-06-30", compare: "previous-year" });
    expect(withPrev.ok && withPrev.value.previousHasData).toBe(true);
    const noPrev = getBalanceSheet(deps, { asOf: "2025-06-30", compare: "previous-year" });
    expect(noPrev.ok && noPrev.value.previousHasData).toBe(false);
    const plain = getBalanceSheet(deps, { asOf: "2026-06-30" });
    expect(plain.ok && "previousHasData" in plain.value).toBe(false);
  });

  it("貸借対照表: asOf 時点の残高。前年比較では 1 年前の同じ日と比べる", () => {
    f.create(f.sale(100_000, "2026-04-15"));
    f.create(f.sale(70_000, "2025-04-15"));
    const r = getBalanceSheet(deps, { asOf: "2026-06-30", compare: "previous-year" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.previousAsOf).toBe("2025-06-30");
    expect(r.value.netIncome).toEqual({ amount: 100_000, previous: 70_000, change: 30_000 });
    expect(r.value.balanced).toBe(true);
  });

  it("FR-033: 資産のマイナス残高と、期首残高の未登録を警告する", () => {
    f.create({
      date: "2025-03-01",
      lines: [f.line("debit", "旅費交通費", 5_000), f.line("credit", "現金", 5_000)],
    });
    const r = getTrialBalance(deps, { from: "2025-01-01", to: "2025-12-31" });
    expect(r.ok && r.value.warnings.map((w) => w.code)).toEqual([
      "OPENING_BALANCE_MISSING",
      "NEGATIVE_BALANCE",
    ]);
  });

  it("仕訳帳の警告は to を含む会計期間で判定する", () => {
    const r = getJournalBook(deps, { from: "2024-01-01", to: "2025-12-31" });
    expect(r.ok && r.value.warnings.map((w) => w.code)).toEqual(["OPENING_BALANCE_MISSING"]);
  });
});
