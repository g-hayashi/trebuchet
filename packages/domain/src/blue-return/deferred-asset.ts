import type { AdjustmentProposal, BlueReturn } from "@trebuchet/schema";
import { addMonths, isValidDate, monthIndex, monthOfDate, yearOfDate } from "../dates.ts";
import {
  type Account,
  type AdjustmentRef,
  type DeferredAmortization,
  type DeferredAmortizationView,
  type DeferredAsset,
  domainError,
  err,
  ok,
  type Result,
  type TaxParameter,
} from "../types.ts";
import { accountByCode, DEPRECIATION_ACCOUNT_CODE } from "./depreciation.ts";
import { resolveTaxParameter } from "./tax-parameters.ts";

/** 開業費の登録の入力。id は更新のときだけ */
export type DeferredAssetDraft = Omit<DeferredAsset, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

const MAX_AMOUNT = 1e12;
const BUSINESS_RATIO = 10000;

const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/**
 * 開業費の登録を検証する（FR-012、R5）。
 * 名称は空でなく、総額は 1 円以上 10^12 円未満の整数、開業日は実在する YYYY-MM-DD（VALIDATION、field つき）。
 * 勘定は区分が資産の科目（ASSET_ACCOUNT_INVALID）。前年までの累計は 0 以上総額以下の整数で、
 * 0 より大きければ累計の年が必要、累計の年は整数で開業の年以上（PRIOR_ACCUMULATED_INVALID、field つき）。
 * 名前・備考の空白を除き、空の備考は null にした入力を返す
 */
export function validateDeferredAsset(
  draft: DeferredAssetDraft,
  ctx: { accounts: readonly Account[] },
): Result<DeferredAssetDraft> {
  const fail = (field: string, message: string) =>
    err(domainError("VALIDATION", message, { field }));
  const priorFail = (field: "priorAccumulated" | "priorThroughYear", message: string) =>
    err(domainError("PRIOR_ACCUMULATED_INVALID", message, { field }));

  const name = draft.name.trim();
  if (name === "") return fail("name", "名称を入力してください");
  if (
    !Number.isSafeInteger(draft.totalAmount) ||
    draft.totalAmount <= 0 ||
    draft.totalAmount >= MAX_AMOUNT
  ) {
    return fail("totalAmount", "支出の総額は 1 円以上の整数で入力してください");
  }
  if (!isValidDate(draft.openedOn)) {
    return fail("openedOn", "開業日は YYYY-MM-DD で入力してください");
  }
  const account = ctx.accounts.find((a) => a.id === draft.accountId);
  if (account === undefined || account.category !== "asset") {
    return err(
      domainError("ASSET_ACCOUNT_INVALID", "開業費の勘定は区分が資産の科目に限ります", {
        field: "accountId",
        accountId: draft.accountId,
        allowedCategory: "asset",
      }),
    );
  }
  if (
    !Number.isSafeInteger(draft.priorAccumulated) ||
    draft.priorAccumulated < 0 ||
    draft.priorAccumulated > draft.totalAmount
  ) {
    return priorFail(
      "priorAccumulated",
      "前年までの償却累計額は 0 円以上、総額以下の整数で入力してください",
    );
  }
  const through = draft.priorThroughYear;
  if (through !== null && !Number.isSafeInteger(through)) {
    return priorFail("priorThroughYear", "累計の年は整数で入力してください");
  }
  if (draft.priorAccumulated > 0 && through === null) {
    return priorFail("priorThroughYear", "前年までの償却累計額には、何年分までかの入力が必要です");
  }
  if (through !== null && through < yearOfDate(draft.openedOn)) {
    return priorFail("priorThroughYear", "累計の年は開業の年以後にしてください");
  }
  return ok({ ...draft, name, note: blankToNull(draft.note) });
}

/** 台帳が計算を始める年度（累計の年の翌年、なければ開業の年）。これより前の年度は計算しない */
export function deferredStartYear(asset: DeferredAsset): number {
  return asset.priorThroughYear !== null ? asset.priorThroughYear + 1 : yearOfDate(asset.openedOn);
}

/** 切上げの整数の割り算（n ≥ 0。浮動小数の商を使わない） */
function ceilDiv(n: number, divisor: number): number {
  const remainder = n % divisor;
  return (n - remainder) / divisor + (remainder > 0 ? 1 : 0);
}

/** `deferredAmortizationYear` が使う値 */
export type DeferredYearContext = {
  /** 全年度の決定（他の開業費の分があってもよい。この開業費の分だけを使う） */
  decisions: readonly DeferredAmortization[];
  /** 有効な償却の仕訳が結びついた年度の集合（この開業費の分。取り消された仕訳は含めない） */
  activeRefs: ReadonlySet<number>;
  taxParameters: readonly TaxParameter[];
};

/**
 * 年度の開業費の償却の見え方（FR-013、R5、data-model §2.2、INV-58）。保存しない。
 *
 * - 上限 `openingBalance` = 総額 − 前年までの累計 − Σ（開始年度から前の年度までの有効な償却額）。
 *   有効な償却額 = 有効な仕訳が結びついた年度の決定の額（上限で抑える）。仕訳のない決定は数えない
 * - 目安 `target` = min(上限, ⌈総額 × 月数 / 60⌉)。月数は、開業の月から 60 か月（税制の値
 *   `OPENING_COST_AMORTIZATION_MONTHS`）の範囲とその年度の重なり。60 か月を過ぎた年度は 0
 * - `decision` はその年度の決定、`registered` はその年度に有効な仕訳があるか。
 *   `closingBalance` = 上限 − 決定の額（決定の額は上限で抑える。決定がなければ上限のまま）
 * - 開始年度より前の年度は計算しない（目安 0、決定なし、残高は 総額 − 累計 のまま）
 *
 * 60 か月の月数がなければ TAX_PARAMETER_MISSING（details.key・date は開業日）
 */
export function deferredAmortizationYear(
  asset: DeferredAsset,
  fiscalYear: number,
  ctx: DeferredYearContext,
): Result<DeferredAmortizationView> {
  const months = resolveTaxParameter(
    "OPENING_COST_AMORTIZATION_MONTHS",
    asset.openedOn,
    ctx.taxParameters,
  );
  if (months === undefined) {
    return err(
      domainError(
        "TAX_PARAMETER_MISSING",
        `開業日（${asset.openedOn}）に適用される開業費の均等償却の月数がありません`,
        { key: "OPENING_COST_AMORTIZATION_MONTHS", date: asset.openedOn },
      ),
    );
  }
  const initial = asset.totalAmount - asset.priorAccumulated;
  const start = deferredStartYear(asset);
  if (fiscalYear < start) {
    return ok({
      fiscalYear,
      openingBalance: initial,
      target: 0,
      decision: null,
      registered: false,
      closingBalance: initial,
    });
  }
  const decisionOf = (year: number) =>
    ctx.decisions.find((d) => d.deferredAssetId === asset.id && d.fiscalYear === year) ?? null;

  let opening = initial;
  for (let year = start; year < fiscalYear; year++) {
    const d = decisionOf(year);
    if (d !== null && ctx.activeRefs.has(year)) opening -= Math.min(d.amount, opening);
  }

  const year4 = String(fiscalYear).padStart(4, "0");
  const openedMonth = monthOfDate(asset.openedOn);
  const windowFirst = monthIndex(openedMonth);
  const windowLast = monthIndex(addMonths(openedMonth, months.value - 1));
  const overlap = Math.max(
    0,
    Math.min(monthIndex(`${year4}-12`), windowLast) -
      Math.max(monthIndex(`${year4}-01`), windowFirst) +
      1,
  );
  const target = Math.min(opening, ceilDiv(asset.totalAmount * overlap, months.value));

  const decision = decisionOf(fiscalYear);
  return ok({
    fiscalYear,
    openingBalance: opening,
    target,
    decision,
    registered: ctx.activeRefs.has(fiscalYear),
    closingBalance: opening - Math.min(decision?.amount ?? 0, opening),
  });
}

/**
 * 年度の償却額の決定を検査する（FR-014、INV-58）。0 以上の整数でなければ VALIDATION（field は amount）、
 * 上限（期首の未償却残高）を超えれば DEFERRED_AMORTIZATION_OVER_LIMIT（details.limit）
 */
export function validateDeferredDecision(
  view: Pick<DeferredAmortizationView, "openingBalance">,
  amount: number,
): Result<number> {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return err(
      domainError("VALIDATION", "償却額は 0 円以上の整数で入力してください", { field: "amount" }),
    );
  }
  if (amount > view.openingBalance) {
    return err(
      domainError(
        "DEFERRED_AMORTIZATION_OVER_LIMIT",
        `償却額は未償却残高（${view.openingBalance} 円）以下にしてください`,
        { field: "amount", limit: view.openingBalance },
      ),
    );
  }
  return ok(amount);
}

/**
 * 開業費の償却の仕訳の案（FR-015〜017、R5、data-model §2.3、INV-23）。
 * 「減価償却費（5180）/ 開業費の勘定」を決定の額で、日付は年度末日、税区分は対象外。家事分はない。
 * 案なし（null）: 決定がない・0 円、その年度に有効な仕訳がある（登録済み。FR-017）。
 * 減価償却費の科目がなければ ACCOUNT_NOT_FOUND（details.code）。
 * 年度の締め済みの判定は呼び出す側（FR-021）
 */
export function proposeDeferredAmortization(
  asset: DeferredAsset,
  view: DeferredAmortizationView,
  fiscalYear: number,
  accounts: readonly Account[],
): Result<AdjustmentProposal | null> {
  const amount = view.decision?.amount ?? 0;
  if (amount <= 0 || view.registered) return ok(null);
  const expense = accountByCode(accounts, DEPRECIATION_ACCOUNT_CODE);
  if (!expense.ok) return expense;
  const taxCategory = "OUT_OF_SCOPE" as const;
  return ok({
    kind: "deferred_amortization",
    sourceId: asset.id,
    journal: {
      date: `${fiscalYear}-12-31`,
      memo: `開業費の償却（${asset.name}）`,
      lines: [
        { side: "debit", accountId: expense.value.id, amount, taxCategory },
        { side: "credit", accountId: asset.accountId, amount, taxCategory },
      ],
    },
    breakdown: {
      totalAmount: asset.totalAmount,
      openingBalance: view.openingBalance,
      amount,
      target: view.target,
      closingBalance: view.closingBalance,
    },
  });
}

/** 決算整理の出所の参照と、その仕訳が取り消されていないか（有効か）。全年度の分を渡す */
export type AdjustmentRefStatus = AdjustmentRef & { active: boolean };

/** 開業費ごとの、有効な償却の仕訳が結びついた年度の集合（`deferredRows` の `activeRefs`） */
export function activeDeferredYears(
  refs: readonly AdjustmentRefStatus[],
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const r of refs) {
    if (r.kind !== "deferred_amortization" || r.deferredAssetId === null || !r.active) continue;
    const years = out.get(r.deferredAssetId) ?? new Set<number>();
    years.add(r.fiscalYear);
    out.set(r.deferredAssetId, years);
  }
  return out;
}

/** `deferredRows` などが使う値 */
export type DeferredContext = {
  decisions: readonly DeferredAmortization[];
  /** 開業費の ID → 有効な償却の仕訳が結びついた年度の集合（なければ空） */
  activeRefs: ReadonlyMap<string, ReadonlySet<number>>;
  taxParameters: readonly TaxParameter[];
};

/** 開業費ごとの年度の見え方（計算できない開業費は含めない） */
export function deferredViews(
  assets: readonly DeferredAsset[],
  fiscalYear: number,
  ctx: DeferredContext,
): { asset: DeferredAsset; view: DeferredAmortizationView }[] {
  return assets.flatMap((asset) => {
    const r = deferredAmortizationYear(asset, fiscalYear, {
      decisions: ctx.decisions,
      activeRefs: ctx.activeRefs.get(asset.id) ?? new Set(),
      taxParameters: ctx.taxParameters,
    });
    return r.ok ? [{ asset, view: r.value }] : [];
  });
}

type DepreciationRow = BlueReturn["page3"]["depreciation"][number];

/**
 * 決算書 3 ページの開業費の行（FR-019、R11）。その年度の決定の額が 0 より大きい開業費だけ
 * （仕訳の登録の有無を問わない。登録がなければ欄 18 との不一致で分かる）。開業日・ID の順。
 * `source` は deferred_asset、`method` は deferred、取得価額・償却の基礎は総額、事業専用割合は 100%、
 * 必要経費算入額は決定の額、未償却残高は期末（上限 − 決定の額）。計算できない開業費は載せない
 */
export function deferredRows(
  assets: readonly DeferredAsset[],
  fiscalYear: number,
  ctx: DeferredContext,
): DepreciationRow[] {
  return deferredViews(assets, fiscalYear, ctx)
    .filter(({ view }) => (view.decision?.amount ?? 0) > 0)
    .sort(
      (a, b) =>
        a.asset.openedOn.localeCompare(b.asset.openedOn) || a.asset.id.localeCompare(b.asset.id),
    )
    .map(({ asset, view }) => {
      const amount = view.decision?.amount ?? 0;
      return {
        assetId: asset.id,
        name: asset.name,
        quantity: null,
        acquiredOn: asset.openedOn,
        cost: asset.totalAmount,
        source: "deferred_asset",
        method: "deferred",
        usefulLifeYears: null,
        ratePermille: null,
        months: null,
        disposedOn: null,
        base: asset.totalAmount,
        ordinary: amount,
        total: amount,
        businessRatio: BUSINESS_RATIO,
        deductible: amount,
        closingBookValue: view.closingBalance,
        note: asset.note,
      };
    });
}
