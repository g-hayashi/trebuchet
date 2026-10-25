import { beforeEach, describe, expect, it } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import { getBlueReturn, saveClosingNote } from "../../src/usecases/blue-return.ts";
import { replaceOpeningBalances } from "../../src/usecases/masters.ts";
import { fakeClosingUnitOfWork, InMemoryClosingStore } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

let fx: ReturnType<typeof setupLedger>;
let closing: InMemoryClosingStore;

const deps = () => ({
  uow: fakeClosingUnitOfWork(fx.ledger, fx.masters, closing),
  masters: fx.masters,
  reports: new InMemoryReportRepository(fx.ledger, fx.masters),
  closing,
  ids: fx.ids,
  clock: fx.clock,
});

beforeEach(() => {
  fx = setupLedger();
  closing = new InMemoryClosingStore(fx.ledger);
  closing.taxParameters = [...TAX_PARAMETERS];
});

const get = (fiscalYear: number) => {
  const r = getBlueReturn(deps(), { fiscalYear });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const setOpening = (fiscalYear: number, cash: number) => {
  const r = replaceOpeningBalances({ repo: fx.masters, ids: fx.ids, clock: fx.clock }, fiscalYear, [
    { accountId: fx.accountId("現金"), side: "debit", amount: cash },
    { accountId: fx.accountId("元入金"), side: "credit", amount: cash },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};

/** 2025 年度: 期首 現金 300,000 / 元入金、売上 100,000（現金）、事業主貸 20,000。2026 年度の期首は 現金 380,000 */
const book2025 = () => {
  setOpening(2025, 300_000);
  fx.create({
    date: "2025-05-10",
    memo: "売上",
    lines: [fx.line("debit", "現金", 100_000), fx.line("credit", "売上高", 100_000)],
  });
  fx.create({
    date: "2025-08-10",
    memo: "生活費",
    lines: [fx.line("debit", "事業主貸", 20_000), fx.line("credit", "現金", 20_000)],
  });
};

const codes = (r: ReturnType<typeof get>) => r.warnings.map((w) => w.code);
const cashAt = (r: ReturnType<typeof get>, when: "opening" | "closing") =>
  r.page4[when].assets.rows.find((x) => x.label === "現金")?.amount;

describe("getBlueReturn の4ページ（T027, US4）", () => {
  it("帳簿の最初の年度（前の年度の会計期間がない）は「前の年度なし」。期首は登録した期首残高", () => {
    book2025();
    const r = get(2025);
    expect(r.page4.carryForwardCheck).toBe("no_prior_year");
    expect(cashAt(r, "opening")).toBe(300_000);
    expect(cashAt(r, "closing")).toBe(380_000);
    expect(r.page4.closing.assets.total).toBe(r.page4.closing.liabilityEquity.total);
  });

  it("前の年度の会計期間があっても期首残高も仕訳もなければ「前の年度なし」", () => {
    setOpening(2026, 1_000);
    const r = get(2026);
    expect(r.page4.carryForwardCheck).toBe("no_prior_year");
    expect(codes(r)).not.toContain("PRIOR_PERIOD_OPEN");
  });

  it("前の年度の期末を読んで繰越を検査する。締め前なら PRIOR_PERIOD_OPEN、締めると消える", () => {
    book2025();
    setOpening(2026, 380_000);
    const open = get(2026);
    expect(open.page4.carryForwardCheck).toBe("matched");
    expect(codes(open)).toContain("PRIOR_PERIOD_OPEN");
    expect(codes(open)).not.toContain("OPENING_MISMATCH");

    fx.closeYear(2025);
    const closed = get(2026);
    expect(closed.page4.carryForwardCheck).toBe("matched");
    expect(codes(closed)).not.toContain("PRIOR_PERIOD_OPEN");
  });

  it("期首が前の年度の期末からの繰越と違えば OPENING_MISMATCH。差の説明を保存すると警告と4ページに添えられる", () => {
    book2025();
    setOpening(2026, 400_000);
    const before = get(2026);
    expect(before.page4.carryForwardCheck).toBe("mismatched");
    const mismatches = before.warnings.filter((w) => w.code === "OPENING_MISMATCH");
    expect(mismatches.map((w) => w.details)).toEqual([
      {
        accountId: fx.accountId("現金"),
        accountName: "現金",
        expected: 380_000,
        actual: 400_000,
        diff: 20_000,
        note: null,
      },
      {
        accountId: fx.accountId("元入金"),
        accountName: "元入金",
        expected: 380_000,
        actual: 400_000,
        diff: 20_000,
        note: null,
      },
    ]);

    const body = "前の年度の現金の数え間違い";
    const saved = saveClosingNote(deps(), { fiscalYear: 2026, kind: "opening_difference", body });
    expect(saved.ok).toBe(true);
    const after = get(2026);
    const withNote = after.warnings.filter((w) => w.code === "OPENING_MISMATCH");
    expect(withNote.map((w) => w.details?.note)).toEqual([body, body]);
    expect(withNote.map((w) => w.details?.diff)).toEqual([20_000, 20_000]);
    expect(after.page4.openingDifferenceNote).toBe(body);
  });
});

describe("saveClosingNote（T027, FR-030）", () => {
  it("年度・種類ごとに保存し、closing_audit_log に closing_note（初回 create、以降 update）を残す", () => {
    const first = saveClosingNote(deps(), {
      fiscalYear: 2025,
      kind: "opening_difference",
      body: "  説明1  ",
    });
    expect(first).toEqual({
      ok: true,
      value: {
        fiscalYear: 2025,
        kind: "opening_difference",
        body: "説明1",
        updatedAt: fx.clock.now(),
      },
    });
    const second = saveClosingNote(deps(), {
      fiscalYear: 2025,
      kind: "opening_difference",
      body: "説明2",
    });
    expect(second.ok).toBe(true);
    saveClosingNote(deps(), { fiscalYear: 2025, kind: "special_circumstances", body: "特殊事情" });

    expect(closing.listClosingNotes(2025).map((n) => [n.kind, n.body])).toEqual(
      expect.arrayContaining([
        ["opening_difference", "説明2"],
        ["special_circumstances", "特殊事情"],
      ]),
    );
    expect(closing.listClosingNotes(2025)).toHaveLength(2);

    const audits = closing.state.audits.filter((a) => a.targetType === "closing_note");
    expect(audits.map((a) => [a.targetId, a.action])).toEqual([
      ["2025:opening_difference", "create"],
      ["2025:opening_difference", "update"],
      ["2025:special_circumstances", "create"],
    ]);
    expect(JSON.parse(audits[1]?.beforeJson ?? "null")?.body).toBe("説明1");
    expect(JSON.parse(audits[1]?.afterJson ?? "null")?.body).toBe("説明2");
    expect(audits[0]?.beforeJson).toBeNull();
  });

  it("締め済みの年度でも保存できる（メモは帳簿ではない）", () => {
    fx.closeYear(2025);
    const r = saveClosingNote(deps(), { fiscalYear: 2025, kind: "opening_difference", body: "x" });
    expect(r.ok).toBe(true);
  });

  it("5000 文字を超える説明・会計期間のない年度は VALIDATION", () => {
    const long = saveClosingNote(deps(), {
      fiscalYear: 2025,
      kind: "opening_difference",
      body: "あ".repeat(5001),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe("VALIDATION");
    const noYear = saveClosingNote(deps(), {
      fiscalYear: 2030,
      kind: "opening_difference",
      body: "x",
    });
    expect(noYear.ok).toBe(false);
    if (!noYear.ok) expect(noYear.error.code).toBe("VALIDATION");
    expect(closing.state.audits).toHaveLength(0);
  });
});
