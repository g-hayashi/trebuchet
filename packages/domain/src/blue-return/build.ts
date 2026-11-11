import type { BlueReturn, BlueReturnWarning, StatementRow } from "@trebuchet/schema";
import { yearOfDate } from "../dates.ts";
import { type OpeningInput, sumAmounts } from "../reports/common.ts";
import { buildProfitAndLoss } from "../reports/profit-and-loss.ts";
import { formatSignedAmount } from "../reports/warnings.ts";
import type {
  Account,
  AdjustmentRef,
  ClosingNote,
  DeductionAnswers,
  DeferredAmortization,
  DeferredAsset,
  FiscalPeriod,
  FixedAsset,
  HomeUseAllocation,
  PostedLine,
  RentDetail,
  StraightLineRate,
  TaxParameter,
} from "../types.ts";
import { checkAssetRegister } from "./asset-register.ts";
import { buildPage4, type PriorPeriod } from "./balance-sheet.ts";
import { blueDeduction, blueDeductionCap } from "./deduction.ts";
import {
  type AdjustmentRefStatus,
  activeDeferredYears,
  deferredAmortizationYear,
  deferredRows,
  deferredStartYear,
} from "./deferred-asset.ts";
import { type DepreciationParams, depreciate, isDepreciationRow } from "./depreciation.ts";
import { type BlueReturnForm, formForYear } from "./form.ts";
import { proposeHomeUseAdjustment } from "./home-use.ts";
import { salesWarnings, summarizeMonthlySales, summarizeSalesPartners } from "./sales.ts";
import { assetStartYear } from "./straight-line.ts";

/** 地代家賃の欄（様式の欄23）。内訳の必要経費算入額の合計と比べる */
const RENT_LINE_NO = 23;
/** 減価償却費の欄（様式の欄18）。3ページの必要経費算入額の合計と比べる */
const DEPRECIATION_LINE_NO = 18;

/**
 * 決算書の入力。1ページ・控除・家事按分・地代家賃の内訳・固定資産・4ページ（期首残高・前の年度・メモ）を持つ。
 * - period: 年度（fiscalYear・期間・状態）
 * - lines: 年度の仕訳の行（001 の PostedLine。取消済みと期間外は buildProfitAndLoss が除く）
 * - deductionAnswers: 控除の要件の回答。なければ null
 * - allocations: 年度の家事按分の登録。なければ空
 * - adjustmentRefs: 年度の決算整理の仕訳の出所。なければ空
 * - rentDetails: 年度の地代家賃の内訳（sortOrder の順に2ページへ載せる）。なければ空
 * - fixedAssets: 固定資産台帳の全件（年度の絞り込みは buildBlueReturn が行う）。なければ空
 */
export type BuildBlueReturnInput = {
  period: FiscalPeriod;
  accounts: readonly Account[];
  lines: readonly PostedLine[];
  deductionAnswers: DeductionAnswers | null;
  taxParameters: readonly TaxParameter[];
  allocations?: readonly HomeUseAllocation[];
  adjustmentRefs?: readonly AdjustmentRef[];
  rentDetails?: readonly RentDetail[];
  fixedAssets?: readonly FixedAsset[];
  /** 定額法の償却率の表（009）。償却率がない定額法の資産は行に載せず、DEPRECIATION_PARAMETER_MISSING で警告する */
  straightLineRates: readonly StraightLineRate[];
  /** 開業費（009 R5）。なければ空 */
  deferredAssets?: readonly DeferredAsset[];
  /** 開業費の全年度の償却額の決定（期首の上限は前の年度の決定から求める）。なければ空 */
  deferredAmortizations?: readonly DeferredAmortization[];
  /**
   * 全年度の決算整理の出所の参照と、その仕訳が有効（取り消されていない）か。開業費の有効な償却額
   * （前の年度の決定のうち有効な仕訳のあるもの）に使う。なければ空
   */
  adjustmentRefsAll?: readonly AdjustmentRefStatus[];
  /** 年度の期首残高（001）。なければ空 */
  opening?: readonly OpeningInput[];
  /** 前の年度（期首残高か仕訳があるときだけ）。なければ null で、繰越の検査をしない */
  priorPeriod?: PriorPeriod | null;
  /** 年度の決算のメモ（opening_difference を繰越の警告に添える） */
  closingNotes?: readonly ClosingNote[];
};

type Page1Line = BlueReturn["page1"]["lines"][number];

/** 一般の欄（kind = account）の番号の集合 */
const accountLineNos = (form: BlueReturnForm) =>
  new Set(form.pl.filter((l) => l.kind === "account").map((l) => l.no));

/**
 * 按分の振替が帳簿と合っていない登録ごとの警告（FR-016）。判定は proposeHomeUseAdjustment の差額が
 * 0 でないこと（差額の計算はそこだけに持つ）。対象の科目が費用でなくなった登録は、案を作れないので
 * エラーコードつきで警告する
 */
function homeUseWarnings(input: BuildBlueReturnInput, period: FiscalPeriod): BlueReturnWarning[] {
  const allocations = input.allocations ?? [];
  const out: BlueReturnWarning[] = [];
  for (const allocation of allocations) {
    const name = input.accounts.find((a) => a.id === allocation.accountId)?.name ?? "";
    const assessed = proposeHomeUseAdjustment({
      allocation,
      allocations,
      accounts: input.accounts,
      period,
      lines: input.lines,
      refs: input.adjustmentRefs ?? [],
    });
    if (!assessed.ok) {
      out.push({
        code: "HOME_USE_ADJUSTMENT_STALE",
        message: `家事按分の対象（${name}）の振替の案を作れません: ${assessed.error.message}`,
        details: {
          allocationId: allocation.id,
          accountId: allocation.accountId,
          subAccountId: allocation.subAccountId,
          errorCode: assessed.error.code,
        },
      });
    } else if (assessed.value.difference !== 0) {
      const { bookAmount, home, registered, difference } = assessed.value;
      out.push({
        code: "HOME_USE_ADJUSTMENT_STALE",
        message: `家事按分の振替（${name}）が帳簿と合っていません。家事分 ${formatSignedAmount(home)} 円に対して振替済みは ${formatSignedAmount(registered)} 円です（差額 ${formatSignedAmount(difference)} 円）`,
        details: {
          allocationId: allocation.id,
          accountId: allocation.accountId,
          subAccountId: allocation.subAccountId,
          bookAmount,
          home,
          registered,
          difference,
        },
      });
    }
  }
  return out;
}

/** 地代家賃の内訳の必要経費算入額の合計が欄23と違うときの警告（FR-017）。内訳が空でも欄23 が 0 でなければ警告する */
function rentDetailsWarnings(
  rows: readonly Pick<RentDetail, "deductibleAmount">[],
  line23: number,
): BlueReturnWarning[] {
  const total = rows.reduce((s, r) => s + r.deductibleAmount, 0);
  if (total === line23) return [];
  return [
    {
      code: "RENT_DETAILS_MISMATCH",
      message: `地代家賃の内訳の必要経費算入額の合計（${formatSignedAmount(total)} 円）が欄23（${formatSignedAmount(line23)} 円）と一致しません`,
      details: { rentDetailsTotal: total, line23, difference: total - line23 },
    },
  ];
}

type DepreciationRow = BlueReturn["page3"]["depreciation"][number];

/** 3ページの減価償却費の計算の行（取得日、ID の順）。載せる資産は isDepreciationRow */
function depreciationRows(
  assets: readonly FixedAsset[],
  fiscalYear: number,
  params: DepreciationParams,
): DepreciationRow[] {
  return assets
    .filter((a) => isDepreciationRow(a, fiscalYear, params))
    .sort((a, b) => a.acquiredOn.localeCompare(b.acquiredOn) || a.id.localeCompare(b.id))
    .flatMap((a): DepreciationRow[] => {
      const r = depreciate(a, fiscalYear, params);
      if (!r.ok) return [];
      const d = r.value;
      return [
        {
          assetId: a.id,
          name: a.name,
          quantity: a.quantity,
          acquiredOn: a.acquiredOn,
          cost: d.cost,
          source: "fixed_asset",
          method: a.method,
          usefulLifeYears: a.usefulLifeYears,
          ratePermille: d.ratePermille,
          months: d.months,
          disposedOn: a.disposedOn,
          base: d.base,
          ordinary: d.ordinary,
          total: d.total,
          businessRatio: d.businessRatio,
          deductible: d.deductible,
          closingBookValue: d.closingBookValue,
          note: a.note,
        },
      ];
    });
}

/**
 * 償却率・税制の値がなく計算できない資産の警告（009 FR-018、R13）。資産ごとに 1 件。
 * 対象はその年度に関わる資産（取得が年度末日以前で、台帳の計算の開始年度以後、除却の年度以前）で、
 * `depreciate` が `TAX_PARAMETER_MISSING` を返すもの。行には載せない（isDepreciationRow）
 */
function parameterMissingWarnings(
  assets: readonly FixedAsset[],
  fiscalYear: number,
  params: DepreciationParams,
): BlueReturnWarning[] {
  const out: BlueReturnWarning[] = [];
  for (const a of [...assets].sort(
    (x, y) => x.acquiredOn.localeCompare(y.acquiredOn) || x.id.localeCompare(y.id),
  )) {
    if (a.method === "small_asset_28_2") continue;
    if (a.acquiredOn > `${fiscalYear}-12-31`) continue;
    if (fiscalYear < assetStartYear(a)) continue;
    if (a.disposedOn !== null && fiscalYear > yearOfDate(a.disposedOn)) continue;
    const d = depreciate(a, fiscalYear, params);
    if (d.ok || d.error.code !== "TAX_PARAMETER_MISSING") continue;
    const key = d.error.details?.key;
    const date = d.error.details?.date;
    out.push({
      code: "DEPRECIATION_PARAMETER_MISSING",
      message: `${a.name}の減価償却費を計算できません（${d.error.message}）`,
      details: { source: "fixed_asset", sourceId: a.id, key, date },
    });
  }
  return out;
}

/**
 * 開業費の均等償却の月数がなく計算できない開業費の警告（009 data-model §2.1、R13）。開業費ごとに 1 件。
 * 対象は開業日が年度末日以前で、台帳の計算の開始年度以後のもの。行には載せない（`deferredRows`）
 */
function deferredParameterMissingWarnings(
  assets: readonly DeferredAsset[],
  fiscalYear: number,
  taxParameters: DepreciationParams["taxParameters"],
): BlueReturnWarning[] {
  const out: BlueReturnWarning[] = [];
  for (const a of [...assets].sort(
    (x, y) => x.openedOn.localeCompare(y.openedOn) || x.id.localeCompare(y.id),
  )) {
    if (a.openedOn > `${fiscalYear}-12-31` || fiscalYear < deferredStartYear(a)) continue;
    const v = deferredAmortizationYear(a, fiscalYear, {
      decisions: [],
      activeRefs: new Set(),
      taxParameters,
    });
    if (v.ok || v.error.code !== "TAX_PARAMETER_MISSING") continue;
    out.push({
      code: "DEPRECIATION_PARAMETER_MISSING",
      message: `${a.name}の償却額を計算できません（${v.error.message}）`,
      details: {
        source: "deferred_asset",
        sourceId: a.id,
        key: v.error.details?.key,
        date: v.error.details?.date,
      },
    });
  }
  return out;
}

/** 必要経費算入額の合計が欄18 と違うときの警告（FR-023）。資産がなくても欄18 が 0 でなければ警告する */
function depreciationWarnings(
  rows: readonly Pick<DepreciationRow, "deductible">[],
  line18: number,
): BlueReturnWarning[] {
  const total = rows.reduce((s, r) => s + r.deductible, 0);
  if (total === line18) return [];
  return [
    {
      code: "DEPRECIATION_MISMATCH",
      message: `3ページの必要経費算入額の合計（${formatSignedAmount(total)} 円）が欄18 の減価償却費（${formatSignedAmount(line18)} 円）と一致しません`,
      details: { depreciationTotal: total, line18, difference: total - line18 },
    },
  ];
}

/**
 * 青色申告決算書（一般用）を帳簿から導出する（research R1）。この関数は1ページと控除・transfer・
 * status・formYear・2ページの月別売上（summarizeMonthlySales）・3ページの売上先
 * （summarizeSalesPartners）・減価償却費の計算・特殊事情のメモ・警告（OPTIONAL_LINES_OVERFLOW、
 * PL_MISMATCH、SALES_*、DUPLICATE_PARTNER_NAME、DEDUCTION_ANSWERS_MISSING）と4ページ
 * （buildPage4。貸借対照表と繰越の検査）を作る。
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
    return {
      no: f.no,
      label: f.kind === "optional" ? (labels.get(f.no) ?? "") : f.label,
      amount,
      kind: f.kind,
    };
  });

  const rentDetails = [...(input.rentDetails ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
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
  const fixedAssets = input.fixedAssets ?? [];
  const depreciationParams: DepreciationParams = {
    rates: input.straightLineRates,
    taxParameters: input.taxParameters,
  };
  const deferredAssets = input.deferredAssets ?? [];
  const deferredDecisions = input.deferredAmortizations ?? [];
  const deferredActiveRefs = activeDeferredYears(input.adjustmentRefsAll ?? []);
  const depreciation = [
    ...depreciationRows(fixedAssets, period.fiscalYear, depreciationParams),
    ...deferredRows(deferredAssets, period.fiscalYear, {
      decisions: deferredDecisions,
      activeRefs: deferredActiveRefs,
      taxParameters: input.taxParameters,
    }),
  ];
  const monthly = summarizeMonthlySales(input.lines, input.accounts, period);
  const partners = summarizeSalesPartners(
    input.lines,
    input.accounts,
    period,
    form.salesPartnerRows,
  );
  warnings.push(
    ...salesWarnings({ line1: amounts.get(1) ?? 0, monthly, partners }),
    ...homeUseWarnings(input, period),
    ...rentDetailsWarnings(rentDetails, amounts.get(RENT_LINE_NO) ?? 0),
    ...depreciationWarnings(depreciation, amounts.get(DEPRECIATION_LINE_NO) ?? 0),
    ...parameterMissingWarnings(fixedAssets, period.fiscalYear, depreciationParams),
    ...deferredParameterMissingWarnings(deferredAssets, period.fiscalYear, input.taxParameters),
    ...checkAssetRegister({
      fiscalYear: period.fiscalYear,
      accounts: input.accounts,
      opening: input.opening ?? [],
      fixedAssets,
      deferredAssets,
      deferredDecisions,
      deferredActiveRefs,
      params: depreciationParams,
    }),
  );
  // その年度の決定（0 円を含む）がある開業費の勘定には、償却していない知らせを出さない（FR-015）
  const decidedAssetIds = new Set(
    deferredDecisions
      .filter((d) => d.fiscalYear === period.fiscalYear)
      .map((d) => d.deferredAssetId),
  );
  const deferredDecidedAccountIds = deferredAssets
    .filter((a) => decidedAssetIds.has(a.id))
    .map((a) => a.accountId);
  const { page4, warnings: page4Warnings } = buildPage4({
    form,
    period,
    accounts: input.accounts,
    opening: input.opening ?? [],
    lines: input.lines,
    priorPeriod: input.priorPeriod ?? null,
    closingNotes: input.closingNotes ?? [],
    deferredDecidedAccountIds,
  });
  warnings.push(...page4Warnings);
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
      monthly,
      rentDetails: rentDetails.map(({ payee, property, annualRent, deductibleAmount }) => ({
        payee,
        property,
        annualRent,
        deductibleAmount,
      })),
      deduction:
        cap === undefined || deduction === null
          ? null
          : { cap: cap.cap, tier: cap.tier, unmet: cap.unmet, amount: deduction },
    },
    page3: {
      salesPartners: {
        rows: partners.rows,
        others: partners.others,
        total: partners.total,
        withoutPartner: partners.withoutPartner,
      },
      depreciation,
      specialCircumstances:
        (input.closingNotes ?? []).find((n) => n.kind === "special_circumstances")?.body || null,
    },
    page4,
    transfer: { businessIncome: line45, blueDeduction: deduction },
    warnings,
  };
}
