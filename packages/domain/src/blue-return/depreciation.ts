import type { AdjustmentProposal } from "@trebuchet/schema";
import { DRAWINGS_ACCOUNT_CODE } from "../carry-forward.ts";
import { formatSignedAmount } from "../reports/warnings.ts";
import {
  type Account,
  type DepreciationMethod,
  domainError,
  err,
  type FixedAsset,
  type LineDraft,
  ok,
  type Result,
  type StraightLineRate,
  type TaxParameter,
} from "../types.ts";
import { computeHomeUse } from "./home-use.ts";
import { lumpSumYear } from "./lump-sum.ts";
import { assetStartYear, straightLineYear } from "./straight-line.ts";
import { resolveStraightLineRate, resolveTaxParameter } from "./tax-parameters.ts";

/** 減価償却費の科目コード（初期セットの 5180。決算書の欄18） */
export const DEPRECIATION_ACCOUNT_CODE = "5180";

const RATIO_DENOMINATOR = 10000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 資産の登録の入力。id は更新のときだけ（編集中の資産を年間の上限の合計から除くのに使う） */
export type FixedAssetDraft = Omit<
  FixedAsset,
  "id" | "createdAt" | "updatedAt" | "disposedOn" | "disposalKind"
> & {
  id?: string;
};

const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

const yearOf = (date: string) => date.slice(0, 4);

/** 償却の計算に必要な値の表（定額法の償却率と税制の値）。`depreciate` などが受け取る（009 D: §2） */
export type DepreciationParams = {
  rates: readonly StraightLineRate[];
  taxParameters: readonly TaxParameter[];
};

/**
 * 資産の登録を検証する（FR-001〜004、FR-018〜020、R1、R4、R7、INV-21）。
 * 方法は少額の特例・定額法・一括償却（それ以外は DEPRECIATION_METHOD_UNSUPPORTED）、
 * 資産の勘定は区分が資産の科目（ASSET_ACCOUNT_INVALID）。
 * 共通: 供用日は取得日以後（VALIDATION、field は inServiceOn）、前年までの累計は 0 以上の整数で、
 * 累計があれば累計の年が必要で供用の年以上（PRIOR_ACCUMULATED_INVALID）。
 * 定額法: 耐用年数が率の表にない・取得日に率がなければ USEFUL_LIFE_UNSUPPORTED
 * （details.usefulLifeYears・acquiredOn）、累計は取得価額 − 1 以下、結びつける仕訳は指定できない
 * （VALIDATION、field は linkedJournalId）。基準額・年間の上限の検査はしない。
 * 一括償却（R4）: 累計は取得価額以下、結びつける仕訳・耐用年数は指定できない（VALIDATION）、取得日に適用される
 * 取得価額の範囲（LUMP_SUM_COST_MIN 以上 LUMP_SUM_COST_MAX 未満）の外なら LUMP_SUM_COST_OUT_OF_RANGE
 * （details.min・max）、範囲の行がなければ TAX_PARAMETER_MISSING（details.key・date）。
 * 少額の特例の年間の上限の集計には数えない（FR-004）。
 * 少額の特例: 供用日・累計・累計の年は指定できない。取得の日に基準額・年間の上限が適用されなければ
 * SMALL_ASSET_NOT_APPLICABLE、取得価額が基準額以上なら SMALL_ASSET_OVER_THRESHOLD
 * （details.threshold・effectiveFrom）、同じ年（1〜12月）に取得した特例の資産の取得価額の合計（除却したか
 * どうかに関わらない。特例を使ったため。draft.id と同じ資産は除く。他の方法の資産は数えない）に今回を足して
 * 上限を超えれば SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED（details.limit・total）。
 * 名前・備考の空白を除き、空の数量・備考・供用日は null にした入力を返す
 */
export function validateFixedAsset(
  draft: FixedAssetDraft,
  sameYearAssets: readonly FixedAsset[],
  params: DepreciationParams & { accounts: readonly Account[] },
): Result<FixedAssetDraft> {
  const fail = (field: string, message: string) =>
    err(domainError("VALIDATION", message, { field }));
  const name = draft.name.trim();
  if (name === "") return fail("name", "資産名を入力してください");
  if (
    draft.method !== "small_asset_28_2" &&
    draft.method !== "straight_line" &&
    draft.method !== "lump_sum"
  ) {
    return err(
      domainError(
        "DEPRECIATION_METHOD_UNSUPPORTED",
        "償却の方法は少額減価償却資産の特例（措置法28条の2）・定額法・一括償却資産だけ選べます",
        { field: "method", method: draft.method },
      ),
    );
  }
  const account = params.accounts.find((a) => a.id === draft.assetAccountId);
  if (account === undefined || account.category !== "asset") {
    return err(
      domainError("ASSET_ACCOUNT_INVALID", "資産の勘定は区分が資産の科目に限ります", {
        field: "assetAccountId",
        accountId: draft.assetAccountId,
        allowedCategory: "asset",
      }),
    );
  }
  if (!Number.isSafeInteger(draft.acquisitionCost) || draft.acquisitionCost <= 0) {
    return fail("acquisitionCost", "取得価額は1円以上の整数で入力してください");
  }
  if (
    !Number.isInteger(draft.businessRatio) ||
    draft.businessRatio < 0 ||
    draft.businessRatio > RATIO_DENOMINATOR
  ) {
    return fail("businessRatio", "事業専用割合は 0〜100% で入力してください");
  }
  if (!DATE_PATTERN.test(draft.acquiredOn) || Number.isNaN(Date.parse(draft.acquiredOn))) {
    return fail("acquiredOn", "取得年月日は YYYY-MM-DD で入力してください");
  }
  const inServiceOn = blankToNull(draft.inServiceOn);
  if (inServiceOn !== null) {
    if (!DATE_PATTERN.test(inServiceOn) || Number.isNaN(Date.parse(inServiceOn))) {
      return fail("inServiceOn", "事業の用に供した日は YYYY-MM-DD で入力してください");
    }
    if (inServiceOn < draft.acquiredOn) {
      return fail("inServiceOn", "事業の用に供した日は取得年月日以後にしてください");
    }
  }
  const priorFail = (field: "priorAccumulated" | "priorThroughYear", message: string) =>
    err(domainError("PRIOR_ACCUMULATED_INVALID", message, { field }));
  /** 前年までの累計と累計の年の検査（定額法・一括償却。累計の上限だけが方法で違う） */
  const checkPrior = (maxPrior: number, maxMessage: string): Result<never> | null => {
    if (
      !Number.isSafeInteger(draft.priorAccumulated) ||
      draft.priorAccumulated < 0 ||
      draft.priorAccumulated > maxPrior
    ) {
      return priorFail("priorAccumulated", maxMessage);
    }
    const through = draft.priorThroughYear;
    if (through !== null && !Number.isSafeInteger(through)) {
      return priorFail("priorThroughYear", "累計の年は整数で入力してください");
    }
    if (draft.priorAccumulated > 0 && through === null) {
      return priorFail(
        "priorThroughYear",
        "前年までの償却累計額には、何年分までかの入力が必要です",
      );
    }
    if (through !== null && through < Number(yearOf(inServiceOn ?? draft.acquiredOn))) {
      return priorFail("priorThroughYear", "累計の年は事業の用に供した年以後にしてください");
    }
    return null;
  };

  if (draft.method === "lump_sum") {
    const priorError = checkPrior(
      draft.acquisitionCost,
      "前年までの償却累計額は 0 円以上、取得価額以下の整数で入力してください",
    );
    if (priorError !== null) return priorError;
    if (draft.linkedJournalId !== null) {
      return fail(
        "linkedJournalId",
        "既存の仕訳を結びつけられるのは少額減価償却資産の特例だけです",
      );
    }
    if (draft.usefulLifeYears !== null) {
      return fail("usefulLifeYears", "一括償却資産には耐用年数を指定できません");
    }
    const min = resolveTaxParameter("LUMP_SUM_COST_MIN", draft.acquiredOn, params.taxParameters);
    const max = resolveTaxParameter("LUMP_SUM_COST_MAX", draft.acquiredOn, params.taxParameters);
    const missing =
      min === undefined ? "LUMP_SUM_COST_MIN" : max === undefined ? "LUMP_SUM_COST_MAX" : null;
    if (min === undefined || max === undefined) {
      return err(
        domainError(
          "TAX_PARAMETER_MISSING",
          `取得の日（${draft.acquiredOn}）に適用される一括償却資産の取得価額の範囲がありません`,
          { key: missing, date: draft.acquiredOn },
        ),
      );
    }
    if (draft.acquisitionCost < min.value || draft.acquisitionCost >= max.value) {
      return err(
        domainError(
          "LUMP_SUM_COST_OUT_OF_RANGE",
          `一括償却資産の取得価額は ${formatSignedAmount(min.value)} 円以上 ${formatSignedAmount(max.value)} 円未満です`,
          { field: "acquisitionCost", min: min.value, max: max.value },
        ),
      );
    }
    return ok({
      ...draft,
      name,
      quantity: blankToNull(draft.quantity),
      note: blankToNull(draft.note),
      inServiceOn,
    });
  }

  if (draft.method === "straight_line") {
    const priorError = checkPrior(
      draft.acquisitionCost - 1,
      "前年までの償却累計額は 0 円以上、取得価額 − 1 円以下の整数で入力してください",
    );
    if (priorError !== null) return priorError;
    if (draft.linkedJournalId !== null) {
      return fail(
        "linkedJournalId",
        "既存の仕訳を結びつけられるのは少額減価償却資産の特例だけです",
      );
    }
    const years = draft.usefulLifeYears;
    if (
      years === null ||
      !Number.isInteger(years) ||
      resolveStraightLineRate(years, draft.acquiredOn, params.rates) === undefined
    ) {
      return err(
        domainError(
          "USEFUL_LIFE_UNSUPPORTED",
          `耐用年数（${years ?? "未入力"}）に、取得の日（${draft.acquiredOn}）に適用される定額法の償却率がありません`,
          { field: "usefulLifeYears", usefulLifeYears: years, acquiredOn: draft.acquiredOn },
        ),
      );
    }
    return ok({
      ...draft,
      name,
      quantity: blankToNull(draft.quantity),
      note: blankToNull(draft.note),
      inServiceOn,
    });
  }

  // 少額の特例は、取得の年に取得価額の全額を償却する。供用日・累計は持たない（R1）
  if (draft.priorAccumulated !== 0 || draft.priorThroughYear !== null) {
    return priorFail(
      draft.priorAccumulated !== 0 ? "priorAccumulated" : "priorThroughYear",
      "少額減価償却資産の特例には、前年までの償却累計額を指定できません",
    );
  }
  if (inServiceOn !== null) {
    return fail("inServiceOn", "少額減価償却資産の特例には、事業の用に供した日を指定できません");
  }

  const threshold = resolveTaxParameter(
    "SMALL_ASSET_THRESHOLD",
    draft.acquiredOn,
    params.taxParameters,
  );
  const limit = resolveTaxParameter(
    "SMALL_ASSET_ANNUAL_LIMIT",
    draft.acquiredOn,
    params.taxParameters,
  );
  if (threshold === undefined || limit === undefined) {
    const rows = params.taxParameters.filter((p) => p.key === "SMALL_ASSET_THRESHOLD");
    const appliesFrom = rows.map((p) => p.effectiveFrom).sort()[0] ?? null;
    const ends = rows.map((p) => p.effectiveTo);
    const appliesTo = ends.includes(null) ? null : (ends.sort().at(-1) ?? null);
    return err(
      domainError(
        "SMALL_ASSET_NOT_APPLICABLE",
        `取得の日（${draft.acquiredOn}）には少額減価償却資産の特例が適用されません`,
        { field: "acquiredOn", acquiredOn: draft.acquiredOn, appliesFrom, appliesTo },
      ),
    );
  }
  if (draft.acquisitionCost >= threshold.value) {
    return err(
      domainError(
        "SMALL_ASSET_OVER_THRESHOLD",
        `取得価額が基準額（${formatSignedAmount(threshold.value)} 円）以上のため、少額減価償却資産の特例は使えません`,
        {
          field: "acquisitionCost",
          threshold: threshold.value,
          effectiveFrom: threshold.effectiveFrom,
        },
      ),
    );
  }
  const year = yearOf(draft.acquiredOn);
  const others = sameYearAssets
    .filter(
      (a) => a.id !== draft.id && a.method === "small_asset_28_2" && yearOf(a.acquiredOn) === year,
    )
    .reduce((s, a) => s + a.acquisitionCost, 0);
  const total = others + draft.acquisitionCost;
  if (total > limit.value) {
    return err(
      domainError(
        "SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED",
        `${year}年に特例を使う資産の取得価額の合計（${formatSignedAmount(total)} 円）が年間の上限（${formatSignedAmount(limit.value)} 円）を超えます`,
        { field: "acquisitionCost", limit: limit.value, total },
      ),
    );
  }
  return ok({
    ...draft,
    name,
    quantity: blankToNull(draft.quantity),
    note: blankToNull(draft.note),
    usefulLifeYears: draft.usefulLifeYears ?? null,
    inServiceOn: null,
  });
}

/**
 * 年度の償却の計算の値（決算書3ページの減価償却費の計算のイ〜ヌと、除却。009 data-model §2.1。導出）。
 * `disposalAmount` は除却の年度の定額法だけ正（その年度の償却の後の未償却残高。廃棄なら除却損、
 * 売却なら事業主貸への振替額）、他は 0。`disposalDeductible` は廃棄の除却損の事業分（売却・他は 0）
 */
export type Depreciation = {
  method: DepreciationMethod;
  /** 取得価額 */
  cost: number;
  /** 償却の基礎になる金額 */
  base: number;
  /** 定額法の償却率（千分率）。他の方法は null */
  ratePermille: number | null;
  /** 本年中の償却期間の月数。定額法だけ（他は null） */
  months: number | null;
  /** 期首の未償却残高 */
  openingBookValue: number;
  /** 本年分の普通償却費 */
  ordinary: number;
  /** 本年分の償却費合計 */
  total: number;
  /** 事業専用割合（万分率） */
  businessRatio: number;
  /** 本年分の必要経費算入額 = ⌊償却費 × 事業専用割合 / 10000⌋ */
  deductible: number;
  /** 未償却残高（期末。除却の年度は 0） */
  closingBookValue: number;
  /** 除却の年度だけ、除却の種類（定額法のみ。他は null） */
  disposalKind: "scrap" | "sale" | null;
  disposalAmount: number;
  disposalDeductible: number;
};

/**
 * 少額の特例の年度の償却（003 のまま。FR-021、R7、INV-21）。取得した年に取得価額の全額を償却し、
 * 未償却残高は 0。取得した年以外の償却費・必要経費算入額は 0。年は取得年月日の年（個人は暦年）
 */
function smallAssetYear(asset: FixedAsset, fiscalYear: number): Depreciation {
  const acquiredNow = yearOf(asset.acquiredOn) === String(fiscalYear);
  const base = acquiredNow ? asset.acquisitionCost : 0;
  return {
    method: "small_asset_28_2",
    cost: asset.acquisitionCost,
    base,
    ratePermille: null,
    months: null,
    openingBookValue: base,
    ordinary: base,
    total: base,
    businessRatio: asset.businessRatio,
    deductible: acquiredNow
      ? computeHomeUse(asset.acquisitionCost, asset.businessRatio).business
      : 0,
    closingBookValue: 0,
    disposalKind: null,
    disposalAmount: 0,
    disposalDeductible: 0,
  };
}

/** 定額法の年度の償却（R3、R8）。必要経費算入額・除却損の事業分は 003/R5 の按分の規則（`computeHomeUse`） */
function straightLineDepreciation(
  asset: FixedAsset,
  fiscalYear: number,
  ratePermille: number,
): Depreciation {
  const y = straightLineYear(asset, fiscalYear, ratePermille);
  const disposedNow = asset.disposedOn !== null && yearOf(asset.disposedOn) === String(fiscalYear);
  const disposalKind = disposedNow ? (asset.disposalKind ?? "scrap") : null;
  return {
    method: "straight_line",
    cost: asset.acquisitionCost,
    base: asset.acquisitionCost,
    ratePermille,
    months: y.months,
    openingBookValue: y.openingBookValue,
    ordinary: y.depreciation,
    total: y.depreciation,
    businessRatio: asset.businessRatio,
    deductible: computeHomeUse(y.depreciation, asset.businessRatio).business,
    closingBookValue: y.closingBookValue,
    disposalKind,
    disposalAmount: y.disposalAmount,
    disposalDeductible:
      disposalKind === "scrap" ? computeHomeUse(y.disposalAmount, asset.businessRatio).business : 0,
  };
}

/** 一括償却の年度の償却（R4）。除却の種類・除却額・除却損は常になし（FR-011） */
function lumpSumDepreciation(asset: FixedAsset, fiscalYear: number, years: number): Depreciation {
  const y = lumpSumYear(asset, fiscalYear, years);
  return {
    method: "lump_sum",
    cost: asset.acquisitionCost,
    base: asset.acquisitionCost,
    ratePermille: null,
    months: null,
    openingBookValue: y.openingBookValue,
    ordinary: y.depreciation,
    total: y.depreciation,
    businessRatio: asset.businessRatio,
    deductible: computeHomeUse(y.depreciation, asset.businessRatio).business,
    closingBookValue: y.closingBookValue,
    disposalKind: null,
    disposalAmount: 0,
    disposalDeductible: 0,
  };
}

/**
 * 年度の償却の計算（FR-005〜011、R3、R4）。方法で分ける: 少額の特例は 003 のまま、定額法は
 * `straightLineYear`（率は取得日に適用される行）、一括償却は `lumpSumYear`（年数 `LUMP_SUM_YEARS` は
 * 取得日に適用される行）。率・年数がなければ TAX_PARAMETER_MISSING
 * （details.key は STRAIGHT_LINE_RATE・LUMP_SUM_YEARS、date は取得日）
 */
export function depreciate(
  asset: FixedAsset,
  fiscalYear: number,
  params: DepreciationParams,
): Result<Depreciation> {
  switch (asset.method) {
    case "small_asset_28_2":
      return ok(smallAssetYear(asset, fiscalYear));
    case "straight_line": {
      const rate =
        asset.usefulLifeYears === null
          ? undefined
          : resolveStraightLineRate(asset.usefulLifeYears, asset.acquiredOn, params.rates);
      if (rate === undefined) {
        return err(
          domainError(
            "TAX_PARAMETER_MISSING",
            `耐用年数（${asset.usefulLifeYears ?? "未入力"}）に、取得の日（${asset.acquiredOn}）に適用される定額法の償却率がありません`,
            {
              key: "STRAIGHT_LINE_RATE",
              date: asset.acquiredOn,
              usefulLifeYears: asset.usefulLifeYears,
            },
          ),
        );
      }
      return ok(straightLineDepreciation(asset, fiscalYear, rate.ratePermille));
    }
    case "lump_sum": {
      const years = resolveTaxParameter("LUMP_SUM_YEARS", asset.acquiredOn, params.taxParameters);
      if (years === undefined) {
        return err(
          domainError(
            "TAX_PARAMETER_MISSING",
            `取得の日（${asset.acquiredOn}）に適用される一括償却資産の償却年数がありません`,
            { key: "LUMP_SUM_YEARS", date: asset.acquiredOn },
          ),
        );
      }
      return ok(lumpSumDepreciation(asset, fiscalYear, years.value));
    }
  }
}

/** 少額の特例の資産を3ページの表に載せるか（003 のまま）。取得した年で、その年の末日までに除却していない */
function isSmallAssetRow(asset: FixedAsset, fiscalYear: number): boolean {
  const yearEnd = `${fiscalYear}-12-31`;
  if (asset.acquiredOn > yearEnd) return false;
  if (asset.disposedOn !== null && asset.disposedOn <= yearEnd) return false;
  return yearOf(asset.acquiredOn) === String(fiscalYear);
}

/**
 * 年度の3ページの表に載せる資産か（R11）。少額の特例は取得した年（年度末日までに除却したものを除く）。
 * 定額法は、台帳の計算を始める年度以後で、その年度の償却費が 0 より大きい、またはその年度に取得・除却した資産
 * （除却の翌年度以後、残高 1 円で償却の終わった資産は載せない）。率がなく計算できない資産は載せない
 * （警告は buildBlueReturn の役割）。年度は暦年（個人）
 */
export function isDepreciationRow(
  asset: FixedAsset,
  fiscalYear: number,
  params: DepreciationParams,
): boolean {
  if (asset.method === "small_asset_28_2") return isSmallAssetRow(asset, fiscalYear);
  if (asset.acquiredOn > `${fiscalYear}-12-31`) return false;
  if (fiscalYear < assetStartYear(asset)) return false;
  const d = depreciate(asset, fiscalYear, params);
  if (!d.ok) return false;
  // 一括償却は除却しても台帳に残し、その年度の額が正の間は載せ続ける（FR-011）
  if (asset.method === "lump_sum") return d.value.total > 0;
  if (asset.disposedOn !== null && fiscalYear > Number(yearOf(asset.disposedOn))) return false;
  return (
    d.value.total > 0 ||
    yearOf(asset.acquiredOn) === String(fiscalYear) ||
    (asset.disposedOn !== null && yearOf(asset.disposedOn) === String(fiscalYear))
  );
}

/** 固定資産除却損の科目コード（初期セットの 5300。009/R9）。定額法の廃棄の年度の案だけが使う */
export const DISPOSAL_LOSS_ACCOUNT_CODE = "5300";

const ACCOUNT_LABELS: Record<string, string> = {
  [DEPRECIATION_ACCOUNT_CODE]: "減価償却費",
  [DRAWINGS_ACCOUNT_CODE]: "事業主貸",
  [DISPOSAL_LOSS_ACCOUNT_CODE]: "固定資産除却損",
};

function accountByCode(accounts: readonly Account[], code: string): Result<Account> {
  const account = accounts.find((a) => a.code === code);
  if (account === undefined) {
    return err(
      domainError(
        "ACCOUNT_NOT_FOUND",
        `${ACCOUNT_LABELS[code] ?? ""}の科目（${code}）がありません`,
        {
          code,
        },
      ),
    );
  }
  return ok(account);
}

/** 千分率の償却率を 0.250 の形に（整数の演算だけ） */
const formatRate = (permille: number) =>
  `${Math.floor(permille / 1000)}.${String(permille % 1000).padStart(3, "0")}`;

/** 案の摘要（009/R17 の T011: 方法・月数・率・除却の種類。売却は譲渡所得が範囲外である旨） */
function depreciationMemo(asset: FixedAsset, d: Depreciation): string {
  const percent = `事業専用割合 ${asset.businessRatio / 100}%`;
  if (d.method === "small_asset_28_2") {
    return `減価償却費の計上（${asset.name} 少額減価償却資産 ${percent}）`;
  }
  if (d.method === "lump_sum") {
    return `減価償却費の計上（${asset.name} 一括償却資産 ${percent}）`;
  }
  const detail = `${asset.name} 定額法 償却率 ${formatRate(d.ratePermille ?? 0)} 本年中の償却期間 ${d.months ?? 0}/12 ${percent}`;
  switch (d.disposalKind) {
    case "scrap":
      return `減価償却費と固定資産除却損の計上（${detail} 廃棄による除却）`;
    case "sale":
      return `減価償却費の計上と売却した資産の振替（${detail} 売却による除却。譲渡所得はこのアプリの範囲外で、確定申告書で別に計算する）`;
    case null:
      return `減価償却費の計上（${detail}）`;
  }
}

/**
 * 減価償却の仕訳の案（FR-009、FR-016、003 の FR-021〜022、R7、R8、data-model §2.3、INV-23、INV-57）。
 * 日付は年度末日、行の税区分は対象外（内部の振替）。金額は `depreciate` の値だけから作る。
 *
 * - 償却: 「減価償却費 / 資産の勘定」（償却費）と、家事分があれば「事業主貸 / 減価償却費」（償却費 − 算入額）
 * - 定額法の廃棄の年度: 同じ案に「固定資産除却損 / 資産の勘定」（除却の年度の残高）と、家事分があれば
 *   「事業主貸 / 固定資産除却損」（残高 − 除却損の事業分）
 * - 定額法の売却の年度: 除却損の 2 行の代わりに「事業主貸 / 資産の勘定」（残高の全額。家事分に分けない）
 *
 * 案なし（null）: 結びつけた仕訳（linkedJournalId）がある資産。少額の特例は取得した年以外・年度末日までに
 * 除却した資産。定額法は台帳の計算を始める年度より前と、償却費・除却の残高がともに 0 の年度（償却の終わった
 * 資産、除却の翌年度以後）。一括償却は台帳の計算を始める年度より前と、その年度の額が 0 の年度
 * （除却しても案を作り続け、除却損・振替は出さない。FR-011）。
 * 科目がなければ ACCOUNT_NOT_FOUND（details.code。除却損の科目は廃棄の年度だけ要る）、
 * 率・税制の値がなければ `depreciate` の TAX_PARAMETER_MISSING。
 * 登録済みの案を除くのは呼び出す側（出所の参照を読む）
 */
export function proposeDepreciationAdjustment(
  asset: FixedAsset,
  fiscalYear: number,
  accounts: readonly Account[],
  params: DepreciationParams,
): Result<AdjustmentProposal | null> {
  if (asset.linkedJournalId !== null) return ok(null);
  switch (asset.method) {
    case "small_asset_28_2":
      if (yearOf(asset.acquiredOn) !== String(fiscalYear) || !isSmallAssetRow(asset, fiscalYear)) {
        return ok(null);
      }
      break;
    case "straight_line":
    case "lump_sum":
      if (fiscalYear < assetStartYear(asset)) return ok(null);
      break;
  }
  const computed = depreciate(asset, fiscalYear, params);
  if (!computed.ok) return computed;
  const d = computed.value;
  if (d.total === 0 && d.disposalAmount === 0) return ok(null);

  const expense = accountByCode(accounts, DEPRECIATION_ACCOUNT_CODE);
  if (!expense.ok) return expense;
  const drawings = accountByCode(accounts, DRAWINGS_ACCOUNT_CODE);
  if (!drawings.ok) return drawings;

  // 内部の振替で仕入ではない。課税期間でも既定（費用は仕入 10%）にしない
  const taxCategory = "OUT_OF_SCOPE" as const;
  const lines: LineDraft[] = [];
  const pair = (debitAccountId: string, creditAccountId: string, amount: number) => {
    if (amount <= 0) return;
    lines.push(
      { side: "debit", accountId: debitAccountId, amount, taxCategory },
      { side: "credit", accountId: creditAccountId, amount, taxCategory },
    );
  };
  pair(expense.value.id, asset.assetAccountId, d.total);
  pair(drawings.value.id, expense.value.id, d.total - d.deductible);
  if (d.disposalAmount > 0) {
    if (d.disposalKind === "sale") {
      // 売却: 残高の全額を事業主貸へ（除却損にしない。譲渡所得は範囲外。R8）
      pair(drawings.value.id, asset.assetAccountId, d.disposalAmount);
    } else {
      const loss = accountByCode(accounts, DISPOSAL_LOSS_ACCOUNT_CODE);
      if (!loss.ok) return loss;
      pair(loss.value.id, asset.assetAccountId, d.disposalAmount);
      pair(drawings.value.id, loss.value.id, d.disposalAmount - d.disposalDeductible);
    }
  }
  return ok({
    kind: "depreciation",
    sourceId: asset.id,
    journal: { date: `${fiscalYear}-12-31`, memo: depreciationMemo(asset, d), lines },
    breakdown: {
      method: d.method,
      acquisitionCost: d.cost,
      businessRatio: d.businessRatio,
      depreciation: d.total,
      deductible: d.deductible,
      months: d.months,
      ratePermille: d.ratePermille,
      openingBookValue: d.openingBookValue,
      closingBookValue: d.closingBookValue,
      disposalKind: d.disposalKind,
      disposalAmount: d.disposalAmount,
      disposalDeductible: d.disposalDeductible,
    },
  });
}
