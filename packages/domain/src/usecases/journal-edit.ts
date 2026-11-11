import { checkPeriod } from "../journal.ts";
import type { Clock, IdGenerator, LedgerRepository, MasterRepository } from "../ports.ts";
import {
  domainError,
  err,
  type FiscalPeriod,
  type Journal,
  journalNotFoundError,
  ok,
  type Result,
} from "../types.ts";
import { isLinkedSource, linkedError } from "./create-journal.ts";

/** 訂正・取消のユースケースの依存。ledger と masters は同じテナントの DB */
export type LedgerDeps = {
  ledger: LedgerRepository;
  masters: MasterRepository;
  ids: IdGenerator;
  clock: Clock;
};

/**
 * 訂正・取消のオプション。`linked` は、請求・入金の取消（005）が自分の仕訳を直すときだけ true にする。
 * なければ `source` が invoice・payment の仕訳は JOURNAL_LINKED（R13）
 */
export type EditOptions = { linked?: boolean };

const REASON_MAX = 500;

/** 訂正・取消の理由（FR-019）。前後の空白を除いて 1〜500 文字 */
export function checkReason(reason: string): Result<string> {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > REASON_MAX) {
    return err(
      domainError("REASON_REQUIRED", `理由を入力してください（${REASON_MAX}文字以内）`, {
        field: "reason",
      }),
    );
  }
  return ok(trimmed);
}

/**
 * 訂正・取消できる仕訳を読む。存在する・取消済みでない・version が一致する・
 * 締め済みの期間の仕訳でない（締め済みなら訂正仕訳を案内する）ことを確かめる
 */
export function loadEditableJournal(
  ledger: LedgerRepository,
  journalId: string,
  version: number,
  periods: readonly FiscalPeriod[],
  options: EditOptions = {},
): Result<Journal> {
  const journal = ledger.getJournal(journalId);
  if (journal === undefined) {
    return err(journalNotFoundError(journalId));
  }
  if (journal.status === "voided") {
    return err(
      domainError("JOURNAL_VOIDED", "取り消した仕訳は訂正・取消できません", { journalId }),
    );
  }
  // 請求・入金の仕訳は、請求・入金の取消（linked）だけが直せる（005 R13）
  if (options.linked !== true && isLinkedSource(journal.source)) {
    return err(linkedError(journalId));
  }
  if (journal.version !== version) return err(versionConflict(journal));
  const period = checkPeriod(journal.date, periods);
  if (!period.ok && period.error.code === "PERIOD_CLOSED") return err(period.error);
  return ok(journal);
}

export const versionConflict = (journal: Pick<Journal, "id" | "version">) =>
  domainError(
    "VERSION_CONFLICT",
    "ほかの操作で仕訳が更新されています。最新の内容を読み込んでからやり直してください",
    { journalId: journal.id, currentVersion: journal.version },
  );
