import { auditEntry } from "../audit.ts";
import type { MasterRepository } from "../ports.ts";
import {
  type AuditAction,
  err,
  type FiscalPeriod,
  ok,
  periodNotFound,
  type Result,
} from "../types.ts";
import { checkReason } from "./journal-edit.ts";
import type { MasterDeps } from "./masters.ts";

export type ReopenPeriodInput = { reason: string };

/** 締めと解除の履歴の1項目（FR-025） */
export type FiscalPeriodHistoryEntry = {
  occurredAt: string;
  fiscalYear: number;
  action: Extract<AuditAction, "close" | "reopen">;
  reason: string | null;
};

function findPeriod(repo: MasterRepository, fiscalYear: number): Result<FiscalPeriod> {
  const period = repo.getFiscalPeriodByYear(fiscalYear);
  return period === undefined ? err(periodNotFound(fiscalYear)) : ok(period);
}

function transition(
  deps: MasterDeps,
  tx: MasterRepository,
  before: FiscalPeriod,
  after: FiscalPeriod,
  action: "close" | "reopen",
  reason: string | null,
  now: string,
): FiscalPeriod {
  tx.updateFiscalPeriod(after);
  tx.appendAudit(
    auditEntry(deps, {
      targetType: "fiscal_period",
      targetId: before.id,
      action,
      reason,
      before,
      after,
      at: now,
    }),
  );
  return after;
}

/**
 * 年度を締める（US5, FR-024, FR-025）。closed_at に締めた日時を入れ、audit_log に close を残す。
 * 締め済みの年度は何も変えずにそのまま返す
 */
export function closePeriod(deps: MasterDeps, fiscalYear: number): Result<FiscalPeriod> {
  return deps.repo.transaction((tx) => {
    const found = findPeriod(tx, fiscalYear);
    if (!found.ok) return found;
    const before = found.value;
    if (before.status === "closed") return ok(before);
    const now = deps.clock.now();
    const after: FiscalPeriod = { ...before, status: "closed", closedAt: now };
    return ok(transition(deps, tx, before, after, "close", null, now));
  });
}

/**
 * 年度の締めを理由つきで解除する（US5, FR-024, FR-025）。audit_log に reopen と理由を残す。
 * 締めていない年度は何も変えずにそのまま返す
 */
export function reopenPeriod(
  deps: MasterDeps,
  fiscalYear: number,
  input: ReopenPeriodInput,
): Result<FiscalPeriod> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;
  return deps.repo.transaction((tx) => {
    const found = findPeriod(tx, fiscalYear);
    if (!found.ok) return found;
    const before = found.value;
    if (before.status === "open") return ok(before);
    const after: FiscalPeriod = { ...before, status: "open", closedAt: null };
    return ok(transition(deps, tx, before, after, "reopen", reason.value, deps.clock.now()));
  });
}

/** 締めと解除の履歴（全年度, 記録の順） */
export function getFiscalPeriodHistory(deps: Pick<MasterDeps, "repo">): FiscalPeriodHistoryEntry[] {
  const years = new Map(deps.repo.listFiscalPeriods().map((p) => [p.id, p.fiscalYear]));
  return deps.repo.fiscalPeriodHistory().flatMap((a) => {
    const fiscalYear = years.get(a.targetId);
    if (fiscalYear === undefined || (a.action !== "close" && a.action !== "reopen")) return [];
    return [{ occurredAt: a.occurredAt, fiscalYear, action: a.action, reason: a.reason }];
  });
}
