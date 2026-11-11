import type { AdjustmentProposal, DeferredAssetInput } from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import {
  activeDeferredYears,
  type DeferredAssetDraft,
  deferredAmortizationYear,
  deferredStartYear,
  proposeDeferredAmortization,
  validateDeferredAsset,
  validateDeferredDecision,
} from "../blue-return/deferred-asset.ts";
import { resolveTaxParameter } from "../blue-return/tax-parameters.ts";
import {
  type AdjustmentRef,
  type DeferredAmortization,
  type DeferredAmortizationView,
  type DeferredAsset,
  domainError,
  err,
  ok,
  type Result,
  validation,
} from "../types.ts";
import {
  type BlueReturnDeps,
  type ClosingSettingsDeps,
  type ClosingTxDeps,
  deferredRefStatuses,
  inClosingTx,
  periodClosedError,
  requireIndividual,
  resolveYear,
} from "./blue-return.ts";

/** 開業費の一覧の読み取りの依存（帳簿の有効な仕訳から、前の年度の有効な償却額を求める） */
export type DeferredReadDeps = BlueReturnDeps;

/** 開業費の 1 行。fiscalYear を指定したときだけその年度の償却の見え方（計算できなければ null） */
export type DeferredAssetWithAmortization = DeferredAsset & {
  amortization: DeferredAmortizationView | null;
};

/**
 * 開業費の一覧（GET /deferred-assets）。個人の事業体だけ。fiscalYear があれば各開業費に
 * その年度の上限・目安・決定・登録済みかを付ける（月数の税制の値がなければ null）。
 * 並び順は ClosingStore の順（開業日・ID）。会計期間があるかどうかは問わない
 */
export function listDeferredAssets(
  deps: DeferredReadDeps,
  params: { fiscalYear?: number },
): Result<DeferredAssetWithAmortization[]> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const assets = deps.closing.listDeferredAssets();
  const { fiscalYear } = params;
  if (fiscalYear === undefined) {
    return ok(assets.map((asset) => ({ ...asset, amortization: null })));
  }
  const decisions = deps.closing.listDeferredAmortizations();
  const taxParameters = deps.closing.listTaxParameters();
  const activeRefs = activeDeferredYears(deferredRefStatuses(deps, assets));
  return ok(
    assets.map((asset) => {
      const view = deferredAmortizationYear(asset, fiscalYear, {
        decisions,
        activeRefs: activeRefs.get(asset.id) ?? new Set(),
        taxParameters,
      });
      return { ...asset, amortization: view.ok ? view.value : null };
    }),
  );
}

/**
 * 償却の計算に効く開業費の項目（009/R12）。有効な償却の仕訳があれば変えられない。
 * 名称・備考は変えられる
 */
const DEFERRED_INPUT_FIELDS = [
  "totalAmount",
  "openedOn",
  "priorAccumulated",
  "priorThroughYear",
  "accountId",
] as const satisfies readonly (keyof DeferredAsset)[];

/** 開業費に有効な（取り消されていない）償却の仕訳の年度（昇順・重複なし）と仕訳 ID。仕訳の状態は同じトランザクションから読む */
function activeDeferredRefs(
  deps: ClosingTxDeps,
  deferredAssetId: string,
): { years: number[]; journalIds: string[]; refs: AdjustmentRef[] } {
  const refs = deps.closing
    .listAdjustmentRefsBySource({ deferredAssetId })
    .filter(
      (r) =>
        r.kind === "deferred_amortization" &&
        deps.ledger.getJournal(r.journalId)?.status === "active",
    );
  const years = [...new Set(refs.map((r) => r.fiscalYear))].sort((a, b) => a - b);
  return { years, journalIds: refs.map((r) => r.journalId), refs };
}

const journalExists = (found: { years: number[]; journalIds: string[] }): Result<never> =>
  err(
    domainError(
      "DEPRECIATION_JOURNAL_EXISTS",
      `${found.years.join("・")}年度の開業費の償却の仕訳が登録されています。先にその仕訳を取り消してください`,
      { years: found.years, journalIds: found.journalIds },
    ),
  );

/**
 * 開業費を登録・更新する（FR-012、R5、R12）。params.id があれば更新（作成日時はそのまま）、なければ作る。
 * 検査の順: 個人の事業体 → 更新の対象がある → `validateDeferredAsset` → 開業日に適用される月数の
 * 税制の値がある（TAX_PARAMETER_MISSING）→ 更新で計算に効く項目（総額・開業日・累計とその年・勘定）が
 * 変わるなら、有効な償却の仕訳がないこと（409 DEPRECIATION_JOURNAL_EXISTS、details.years・journalIds）。
 * closing_audit_log に deferred_asset（create / update、理由、変更前・後）を残す。1 つのトランザクション
 */
export function saveDeferredAsset(
  deps: ClosingSettingsDeps,
  params: DeferredAssetInput & { id?: string; reason?: string | null | undefined },
): Result<DeferredAsset> {
  return inClosingTx(deps, (tx) => saveDeferredAssetIn(tx, params));
}

function saveDeferredAssetIn(
  deps: ClosingTxDeps,
  params: DeferredAssetInput & { id?: string; reason?: string | null | undefined },
): Result<DeferredAsset> {
  const individual = requireIndividual(deps.masters);
  if (!individual.ok) return individual;
  const before =
    params.id === undefined
      ? undefined
      : deps.closing.listDeferredAssets().find((a) => a.id === params.id);
  if (params.id !== undefined && before === undefined) {
    return validation("開業費が見つかりません", { field: "id" });
  }
  const draft: DeferredAssetDraft = {
    ...(params.id === undefined ? {} : { id: params.id }),
    name: params.name,
    totalAmount: params.totalAmount,
    openedOn: params.openedOn,
    priorAccumulated: params.priorAccumulated,
    priorThroughYear: params.priorThroughYear ?? null,
    accountId: params.accountId,
    note: params.note ?? null,
  };
  const validated = validateDeferredAsset(draft, { accounts: deps.masters.listAccounts() });
  if (!validated.ok) return validated;
  const months = resolveTaxParameter(
    "OPENING_COST_AMORTIZATION_MONTHS",
    validated.value.openedOn,
    deps.closing.listTaxParameters(),
  );
  if (months === undefined) {
    return err(
      domainError(
        "TAX_PARAMETER_MISSING",
        `開業日（${validated.value.openedOn}）に適用される開業費の均等償却の月数がありません`,
        { key: "OPENING_COST_AMORTIZATION_MONTHS", date: validated.value.openedOn },
      ),
    );
  }
  if (
    before !== undefined &&
    DEFERRED_INPUT_FIELDS.some((field) => validated.value[field] !== before[field])
  ) {
    const found = activeDeferredRefs(deps, before.id);
    if (found.years.length > 0) return journalExists(found);
  }

  const now = deps.clock.now();
  const { id: _draftId, ...fields } = validated.value;
  const saved: DeferredAsset = {
    ...fields,
    id: before?.id ?? deps.ids.next(),
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
  deps.closing.upsertDeferredAsset(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "deferred_asset",
      targetId: saved.id,
      action: before === undefined ? "create" : "update",
      reason: params.reason?.trim() || null,
      before,
      after: saved,
      at: now,
    }),
  );
  return ok(saved);
}

export type DecideDeferredAmortizationParams = {
  deferredAssetId: string;
  fiscalYear: number;
  amount: number;
};

export type DeferredAmortizationDecision = {
  amortization: DeferredAmortizationView;
  proposal: AdjustmentProposal | null;
};

/**
 * 開業費の年度の償却額を決める（FR-014〜015、R5、R12）。1 つの ClosingUnitOfWork の中で、検査の順は
 * 個人の事業体 → 年度がない（VALIDATION）→ 開業費がない（VALIDATION）→ 締め済み（PERIOD_CLOSED）→
 * 開始年度（累計の年の翌年、なければ開業の年）より前（VALIDATION）→ その年度に有効な償却の仕訳がある
 * （409 DEPRECIATION_JOURNAL_EXISTS）→ `validateDeferredDecision`（VALIDATION、
 * DEFERRED_AMORTIZATION_OVER_LIMIT。上限は前の年度の有効な仕訳のある決定だけで減る）。
 * 決定を保存し（同じ年度は更新。決定日時はそのまま）、closing_audit_log に deferred_amortization
 * （対象は `開業費ID:年度`、create / update、変更前・後）を残す。仕訳はまだ作らない（案の確定は
 * commitAdjustment）。案が作れなければ（減価償却費の科目がないなど）何も書かない。
 * 返す案は、0 円・登録済みなら null
 */
export function decideDeferredAmortization(
  deps: ClosingSettingsDeps,
  params: DecideDeferredAmortizationParams,
): Result<DeferredAmortizationDecision> {
  return inClosingTx(deps, (tx) => decideDeferredAmortizationIn(tx, params));
}

function decideDeferredAmortizationIn(
  deps: ClosingTxDeps,
  params: DecideDeferredAmortizationParams,
): Result<DeferredAmortizationDecision> {
  const { deferredAssetId, fiscalYear, amount } = params;
  const period = resolveYear(deps.masters, fiscalYear);
  if (!period.ok) return period;
  const asset = deps.closing.listDeferredAssets().find((a) => a.id === deferredAssetId);
  if (asset === undefined) {
    return validation("開業費が見つかりません", { field: "deferredAssetId" });
  }
  if (period.value.status === "closed") return periodClosedError(fiscalYear);
  const startYear = deferredStartYear(asset);
  if (fiscalYear < startYear) {
    return validation(
      `この開業費の償却は ${startYear} 年度から決められます（それより前の年度は決められません）`,
      { field: "fiscalYear", startYear },
    );
  }
  const active = activeDeferredRefs(deps, asset.id);
  if (active.years.includes(fiscalYear)) {
    return journalExists({
      years: [fiscalYear],
      journalIds: active.refs.filter((r) => r.fiscalYear === fiscalYear).map((r) => r.journalId),
    });
  }

  const decisions = deps.closing.listDeferredAmortizations();
  const viewOf = (all: readonly DeferredAmortization[]) =>
    deferredAmortizationYear(asset, fiscalYear, {
      decisions: all,
      activeRefs: new Set(active.years),
      taxParameters: deps.closing.listTaxParameters(),
    });
  const current = viewOf(decisions);
  if (!current.ok) return current;
  const checked = validateDeferredDecision(current.value, amount);
  if (!checked.ok) return checked;

  const before = decisions.find(
    (d) => d.deferredAssetId === deferredAssetId && d.fiscalYear === fiscalYear,
  );
  const now = deps.clock.now();
  const saved: DeferredAmortization = {
    deferredAssetId,
    fiscalYear,
    amount: checked.value,
    decidedAt: before?.decidedAt ?? now,
    updatedAt: now,
  };
  const amortization = viewOf([
    ...decisions.filter(
      (d) => !(d.deferredAssetId === deferredAssetId && d.fiscalYear === fiscalYear),
    ),
    saved,
  ]);
  if (!amortization.ok) return amortization;
  const proposal = proposeDeferredAmortization(
    asset,
    amortization.value,
    fiscalYear,
    deps.masters.listAccounts(),
  );
  if (!proposal.ok) return proposal;

  deps.closing.upsertDeferredAmortization(saved);
  deps.closing.appendClosingAudit(
    auditEntry(deps, {
      targetType: "deferred_amortization",
      targetId: `${deferredAssetId}:${fiscalYear}`,
      action: before === undefined ? "create" : "update",
      before,
      after: saved,
      at: now,
    }),
  );
  return ok({ amortization: amortization.value, proposal: proposal.value });
}
