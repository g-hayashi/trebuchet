import { beforeEach, describe, expect, it } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import {
  getBlueReturn,
  getDeductionAnswers,
  saveDeductionAnswers,
} from "../../src/usecases/blue-return.ts";
import { addAccount, setAccountReportLine } from "../../src/usecases/masters.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { fakeClosingUnitOfWork, InMemoryClosingStore } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

const ANSWERS = {
  doubleEntry: true,
  statementsAttached: true,
  filedOnTime: true,
  eTax: true,
  electronicBooks: false,
};

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

/** 現金で 1 件の収入または経費を登録する（2025 年度） */
const book = (name: string, amount: number, date = "2025-06-30") => {
  const isIncome = name === "売上高";
  return fx.create({
    date,
    memo: "テスト",
    lines: [
      fx.line(isIncome ? "debit" : "credit", "現金", amount),
      fx.line(isIncome ? "credit" : "debit", name, amount),
    ],
  });
};

const amountOf = (r: { page1: { lines: { no: number; amount: number | null }[] } }, no: number) =>
  r.page1.lines.find((l) => l.no === no)?.amount;

const get = (fiscalYear = 2025) => {
  const r = getBlueReturn(deps(), { fiscalYear });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("getBlueReturn（D: ユースケース）", () => {
  it("年度の仕訳から1ページを作る。取消済みの仕訳は含めない", () => {
    book("売上高", 1_000_000);
    book("消耗品費", 100_000);
    book("通信費", 20_000);
    const voided = book("通信費", 5_000);
    const v = voidJournal(fx.deps, voided.id, { reason: "誤り", version: voided.version });
    expect(v.ok).toBe(true);
    // 年度の外の仕訳は含めない
    book("売上高", 999, "2026-01-05");

    const result = get();
    expect(result.fiscalYear).toBe(2025);
    expect(result.status).toBe("open");
    expect(amountOf(result, 1)).toBe(1_000_000);
    expect(amountOf(result, 12)).toBe(20_000);
    expect(amountOf(result, 17)).toBe(100_000);
    expect(amountOf(result, 32)).toBe(120_000);
    expect(amountOf(result, 33)).toBe(880_000);
    expect(amountOf(result, 43)).toBe(880_000);
    expect(result.warnings.some((w) => w.code === "PL_MISMATCH")).toBe(false);
  });

  it("回答がなければ欄44・45 は null で DEDUCTION_ANSWERS_MISSING、回答を保存すると計算される", () => {
    book("売上高", 1_000_000);
    book("消耗品費", 100_000);
    const before = get();
    expect(before.transfer).toEqual({ businessIncome: null, blueDeduction: null });
    expect(before.warnings.map((w) => w.code)).toContain("DEDUCTION_ANSWERS_MISSING");

    const saved = saveDeductionAnswers(deps(), { fiscalYear: 2025, answers: ANSWERS });
    expect(saved.ok).toBe(true);
    const after = get();
    expect(after.transfer).toEqual({ businessIncome: 250_000, blueDeduction: 650_000 });
    expect(after.warnings.map((w) => w.code)).not.toContain("DEDUCTION_ANSWERS_MISSING");
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED（年度の有無より先に判定する）", () => {
    const profile = fx.masters.getProfile();
    if (profile === undefined) throw new Error("no profile");
    fx.masters.saveProfile({ ...profile, kind: "corporation" });
    for (const fiscalYear of [2025, 1999]) {
      const r = getBlueReturn(deps(), { fiscalYear });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
    }
  });

  it("年度がなければ 001 の締め・解除と同じ VALIDATION（会計期間が見つかりません）", () => {
    const r = getBlueReturn(deps(), { fiscalYear: 1999 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION");
      expect(r.error.message).toBe("会計期間が見つかりません");
    }
  });

  it("締め済みの年度は status が closed", () => {
    fx.closeYear(2025);
    expect(get().status).toBe("closed");
  });

  it("US1 シナリオ10: 任意科目が 7 つで OPTIONAL_LINES_OVERFLOW、1 つを雑費（欄31）に変えると消える", () => {
    const names = ["任意A", "任意B", "任意C", "任意D", "任意E", "任意F", "任意G"];
    for (const [i, name] of names.entries()) {
      const added = addAccount(
        { repo: fx.masters, ids: fx.ids, clock: fx.clock },
        { name, category: "expense", reportSection: "PL_EXPENSE", reportLine: null },
      );
      if (!added.ok) throw new Error(added.error.message);
      fx.create({
        date: "2025-03-31",
        memo: "テスト",
        lines: [
          fx.line("debit", name, 1_000 * (i + 1)),
          fx.line("credit", "現金", 1_000 * (i + 1)),
        ],
      });
    }
    const overflowing = get();
    const warning = overflowing.warnings.find((w) => w.code === "OPTIONAL_LINES_OVERFLOW");
    expect(warning).toBeDefined();
    expect(amountOf(overflowing, 32)).toBe(28_000);

    const target = fx.masters.listAccounts().find((a) => a.name === "任意A");
    if (target === undefined) throw new Error("no account");
    const changed = setAccountReportLine(
      { repo: fx.masters, closing, ids: fx.ids, clock: fx.clock },
      target.id,
      31,
    );
    expect(changed.ok).toBe(true);

    const resolved = get();
    expect(resolved.warnings.map((w) => w.code)).not.toContain("OPTIONAL_LINES_OVERFLOW");
    // 欄31 は任意A だけ（雑費の科目に仕訳はない）
    expect(amountOf(resolved, 31)).toBe(1_000);
    expect(amountOf(resolved, 32)).toBe(28_000);
  });
});

describe("saveDeductionAnswers / getDeductionAnswers", () => {
  it("初回は create、2回目は update で closing_audit_log に blue_deduction_answer を残す", () => {
    const first = saveDeductionAnswers(deps(), { fiscalYear: 2025, answers: ANSWERS });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.answers).toMatchObject({ fiscalYear: 2025, ...ANSWERS });
    expect(first.value.answers?.updatedAt).toBe(fx.clock.now());
    expect(first.value.cap).toEqual({ cap: 650_000, tier: "max", unmet: [] });

    const second = saveDeductionAnswers(deps(), {
      fiscalYear: 2025,
      answers: { ...ANSWERS, eTax: false },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.cap?.tier).toBe("standard");

    expect(closing.audits.map((a) => [a.targetType, a.targetId, a.action])).toEqual([
      ["blue_deduction_answer", "2025", "create"],
      ["blue_deduction_answer", "2025", "update"],
    ]);
    expect(JSON.parse(closing.audits[1]?.beforeJson ?? "null")).toMatchObject({ eTax: true });
    expect(JSON.parse(closing.audits[1]?.afterJson ?? "null")).toMatchObject({ eTax: false });
  });

  it("回答がなければ getDeductionAnswers は answers・cap とも null", () => {
    const r = getDeductionAnswers(deps(), { fiscalYear: 2025 });
    expect(r).toEqual({ ok: true, value: { answers: null, cap: null } });
  });

  it("法人は ENTITY_KIND_UNSUPPORTED、年度がなければ VALIDATION。履歴は残さない", () => {
    const missing = saveDeductionAnswers(deps(), { fiscalYear: 1999, answers: ANSWERS });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("VALIDATION");

    const profile = fx.masters.getProfile();
    if (profile === undefined) throw new Error("no profile");
    fx.masters.saveProfile({ ...profile, kind: "corporation" });
    const corp = saveDeductionAnswers(deps(), { fiscalYear: 2025, answers: ANSWERS });
    expect(corp.ok).toBe(false);
    if (!corp.ok) expect(corp.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
    expect(closing.audits).toHaveLength(0);
  });
});
