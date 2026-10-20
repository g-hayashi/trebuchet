import type { BlueReturn, BlueReturnWarning, StatementRow } from "@trebuchet/schema";
import { buildProfitAndLoss } from "../reports/profit-and-loss.ts";
import type {
  Account,
  DeductionAnswers,
  FiscalPeriod,
  PostedLine,
  TaxParameter,
} from "../types.ts";
import { blueDeduction, blueDeductionCap } from "./deduction.ts";
import { type BlueReturnForm, formForYear } from "./form.ts";

/**
 * 決算書の入力。1ページと控除の部分だけを持つ（2〜4ページの入力は後のタスクで足す）。
 * - period: 年度（fiscalYear・期間・状態）
 * - lines: 年度の仕訳の行（001 の PostedLine。取消済みと期間外は buildProfitAndLoss が除く）
 * - deductionAnswers: 控除の要件の回答。なければ null
 */
export type BuildBlueReturnInput = {
  period: FiscalPeriod;
  accounts: readonly Account[];
  lines: readonly PostedLine[];
  deductionAnswers: DeductionAnswers | null;
  taxParameters: readonly TaxParameter[];
};

type Page1Line = BlueReturn["page1"]["lines"][number];

const emptyBsSide = { rows: [], total: 0 };

const sumAmounts = (rows: readonly { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

/** 一般の欄（kind = account）の番号の集合 */
const accountLineNos = (form: BlueReturnForm) =>
  new Set(form.pl.filter((l) => l.kind === "account").map((l) => l.no));

/**
 * 青色申告決算書（一般用）を帳簿から導出する（research R1）。この関数は1ページと控除・transfer・
 * status・formYear・警告（OPTIONAL_LINES_OVERFLOW、PL_MISMATCH、DEDUCTION_ANSWERS_MISSING）を作る。
 * 2〜4ページ（月別売上、売上先、減価償却、貸借対照表）は空の初期値。
 *
 * - 欄1 = 売上・その他の損益の区分の科目の合計（雑収入を含む）
 * - 欄8〜24・31 = reportLine がその番号の費用（売上原価・経費）の科目
 * - 欄25〜30 = 任意科目（reportLine が 25〜30 の科目と、一般の欄に当たらない費用の科目）を、
 *   金額が 0 でないものだけ科目順に欄25から詰める。6つを超えた分は欄に載せず
 *   （OPTIONAL_LINES_OVERFLOW の details に載せる）、欄32・33・43 には含める
 * - 欄32 = 欄8〜31 の計、欄33 = 欄1 − 欄32、欄43 = 欄33（欄34〜42 は 0）
 * - 使わない欄は常に 0。空欄にするのは表示と CSV（R14）
 */
export function buildBlueReturn(input: BuildBlueReturnInput): BlueReturn {
  const { period } = input;
  const form = formForYear(period.fiscalYear);
  const pl = buildProfitAndLoss({
    accounts: input.accounts,
    lines: input.lines,
    from: period.startDate,
    to: period.endDate,
  });
  const section = (name: string): StatementRow[] =>
    pl.sections.find((s) => s.section === name)?.rows ?? [];

  const generalNos = accountLineNos(form);
  const optionalNos = form.optionalLines;
  const income = [...section("PL_SALES"), ...section("PL_OTHER")];
  const costRows = [...section("PL_COGS"), ...section("PL_EXPENSE")];

  const byLine = new Map<number, number>();
  const optionalRows: StatementRow[] = [];
  for (const row of costRows) {
    if (row.reportLine !== null && generalNos.has(row.reportLine) && row.reportLine !== 1) {
      byLine.set(row.reportLine, (byLine.get(row.reportLine) ?? 0) + row.amount);
    } else if (row.amount !== 0) {
      optionalRows.push(row);
    }
  }
  const placed = optionalRows.slice(0, optionalNos.length);

  const amounts = new Map<number, number>();
  const labels = new Map<number, string>();
  amounts.set(1, sumAmounts(income));
  for (const [no, amount] of byLine) amounts.set(no, amount);
  optionalNos.forEach((no, i) => {
    const row = placed[i];
    if (row !== undefined) {
      amounts.set(no, row.amount);
      labels.set(no, row.name);
    }
  });

  // 欄に載せられなかった任意科目も、計・差引金額には含める（金額を落とさない。INV-18）
  const overflow = optionalRows.slice(optionalNos.length);
  const line32 =
    form.pl
      .filter((l) => l.no >= 8 && l.no <= 31 && l.kind !== "computed")
      .reduce((s, l) => s + (amounts.get(l.no) ?? 0), 0) + sumAmounts(overflow);
  const line33 = (amounts.get(1) ?? 0) - line32;
  const line43 = line33;
  amounts.set(32, line32);
  amounts.set(33, line33);
  amounts.set(43, line43);

  const cap = blueDeductionCap(input.deductionAnswers, period.endDate, input.taxParameters);
  const deduction = cap === undefined ? null : blueDeduction(cap.cap, line43);
  const line45 = deduction === null ? null : line43 - deduction;

  const lines: Page1Line[] = form.pl.map((f) => {
    const amount =
      f.no === 44
        ? deduction
        : f.no === 45
          ? line45
          : f.kind === "unused"
            ? 0
            : (amounts.get(f.no) ?? 0);
    return { no: f.no, label: f.kind === "optional" ? (labels.get(f.no) ?? "") : f.label, amount };
  });

  const warnings: BlueReturnWarning[] = [];
  if (overflow.length > 0) {
    const omitted = overflow.map((r) => ({
      accountId: r.accountId,
      name: r.name,
      amount: r.amount,
    }));
    warnings.push({
      code: "OPTIONAL_LINES_OVERFLOW",
      message: `任意科目が ${optionalRows.length} 個あり、様式の任意欄（${optionalNos.length} 欄）に載りません（金額は計に含めています）: ${omitted.map((o) => o.name).join("、")}`,
      details: { count: optionalRows.length, capacity: optionalNos.length, omitted },
    });
  }
  const plExpense = sumAmounts(costRows);
  if (line32 !== plExpense || line33 !== pl.netIncome.amount) {
    warnings.push({
      code: "PL_MISMATCH",
      message: "決算書の経費計・差引金額が損益計算書の費用合計・利益と一致しません",
      details: {
        line32,
        plExpense,
        line33,
        plNetIncome: pl.netIncome.amount,
      },
    });
  }
  if (cap === undefined) {
    warnings.push({
      code: "DEDUCTION_ANSWERS_MISSING",
      message: "青色申告特別控除の要件の回答が未登録です。控除額と所得金額は計算していません",
      details: { fiscalYear: period.fiscalYear },
    });
  }

  return {
    fiscalYear: period.fiscalYear,
    formYear: form.year,
    status: period.status,
    page1: { lines },
    page2: {
      monthly: { months: [], total: { sales: 0, otherIncome: 0, total: 0 } },
      rentDetails: [],
      deduction:
        cap === undefined || deduction === null
          ? null
          : { cap: cap.cap, tier: cap.tier, unmet: cap.unmet, amount: deduction },
    },
    page3: {
      salesPartners: { rows: [], others: 0, withoutPartner: null },
      depreciation: [],
    },
    page4: {
      opening: { assets: emptyBsSide, liabilityEquity: emptyBsSide },
      closing: { assets: emptyBsSide, liabilityEquity: emptyBsSide },
    },
    transfer: { businessIncome: line45, blueDeduction: deduction },
    warnings,
  };
}
