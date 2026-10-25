import type {
  BlockedRun,
  PauseInput,
  Recurring,
  RecurringDetailResponse,
  RecurringInput,
  RecurringLineView,
  RecurringRunView,
  RecurringStatusResponse,
  RecurringUpdate,
  RecurringView,
  ResumeInput,
  SkipRunInput,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { combineErrors, type JournalContext, validateJournal } from "../journal.ts";
import type { Clock, IdGenerator, RecurringStore, RecurringUnitOfWork } from "../ports.ts";
import {
  planRecurringRuns,
  type RecurringContext,
  type RecurringPlan,
  recurringJournalDraft,
} from "../recurring/due.ts";
import { monthIndex, scheduledDate } from "../recurring/schedule.ts";
import {
  type DomainError,
  domainError,
  err,
  type Journal,
  ok,
  type RecurringRunRecord,
  type Result,
  validation,
} from "../types.ts";
import { createJournal, loadContext } from "./create-journal.ts";
import { checkReason } from "./journal-edit.ts";

/** 定期仕訳（005 US3）のユースケースの依存。読み取りも UnitOfWork 越しに行う（同じ接続・トランザクション） */
export type RecurringDeps = {
  uow: RecurringUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
};

const notFound = (id: string) =>
  err(domainError("RECURRING_NOT_FOUND", "定期仕訳が見つかりません", { recurringId: id }));

const versionConflict = (def: Recurring) =>
  err(
    domainError("VERSION_CONFLICT", "別の操作で更新されています。開き直してください", {
      recurringId: def.id,
      currentVersion: def.version,
    }),
  );

const monthOfDate = (date: string) => date.slice(0, 7);

/** 保存の段階では見ない違反。予定日の期間・消費税の設定は回ごとの判定（blocked）に任せる（R17） */
const TIME_DEPENDENT_CODES: ReadonlySet<string> = new Set([
  "PERIOD_CLOSED",
  "OUT_OF_PERIOD",
  "TAX_SETTING_GAP",
  "TAX_METHOD_UNSUPPORTED",
]);

/**
 * 定義を保存してよいか。開始月の予定日で 001 の `validateJournal` を通し、貸借の不一致・科目・金額などを拒否する（FR-023）。
 * 予定日の期間（締め済み・範囲外）と消費税の設定の違反は、保存を止めずに各回の判定（blocked）で示す
 */
function checkDefinition(
  def: Pick<Recurring, "memo" | "dayOfMonth" | "startMonth" | "endMonth" | "lines">,
  ctx: JournalContext,
): DomainError | undefined {
  if (def.endMonth !== null && def.endMonth < def.startMonth) {
    return domainError("VALIDATION", "終了月は開始月以降にしてください", { field: "endMonth" });
  }
  const validated = validateJournal(recurringJournalDraft(def, def.startMonth), ctx);
  if (validated.ok) return undefined;
  const errors = validated.error.filter((e) => !TIME_DEPENDENT_CODES.has(e.code));
  return errors.length === 0 ? undefined : combineErrors(errors);
}

const trimToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

/** 入力の行を保存する行にする（行番号を振り、省略は null） */
function toLines(lines: RecurringInput["lines"]): RecurringLineView[] {
  return lines.map((l, index) => ({
    lineNo: index + 1,
    side: l.side,
    accountId: l.accountId,
    subAccountId: l.subAccountId ?? null,
    amount: l.amount,
    taxCategory: l.taxCategory ?? null,
    partnerId: l.partnerId ?? null,
    description: trimToNull(l.description),
  }));
}

const doneMonthsOf = (store: RecurringStore, recurringId: string): string[] =>
  store.listRuns(recurringId).map((r) => r.targetMonth);

/**
 * 保存・再開の後に、今日以前に登録される回が 1 件以上あり `confirm` がなければ `RECURRING_CONFIRM_REQUIRED`
 * （`details: { count, months }`。FR-029）
 */
function confirmRequired(
  def: Recurring,
  store: RecurringStore,
  ctx: RecurringContext,
  today: string,
  confirm: boolean | undefined,
): DomainError | undefined {
  const plan = planRecurringRuns({ def, today, doneMonths: doneMonthsOf(store, def.id), ctx });
  if (plan.post.length === 0 || confirm === true) return undefined;
  const months = plan.post.map((p) => p.month);
  return domainError(
    "RECURRING_CONFIRM_REQUIRED",
    `今日以前の ${months.length} 件の仕訳がすぐに登録されます。内容を確かめて、もう一度実行してください`,
    { count: months.length, months },
  );
}

/**
 * 定期仕訳を作る。開始月の予定日で定義を検査し（`checkDefinition`）、登録される回が 1 件以上あれば確認を求める。
 * 定義を保存して記録する（仕訳の登録はしない。`postDueRecurring` が行う）
 */
export function createRecurring(
  deps: RecurringDeps,
  input: RecurringInput,
  today: string,
): Result<Recurring> {
  return deps.uow.run(({ masters, recurring }) => {
    const now = deps.clock.now();
    const def: Recurring = {
      id: deps.ids.next(),
      name: input.name.trim(),
      memo: trimToNull(input.memo),
      dayOfMonth: input.dayOfMonth,
      startMonth: input.startMonth,
      endMonth: input.endMonth ?? null,
      status: "active",
      version: 1,
      lines: toLines(input.lines),
      createdAt: now,
      updatedAt: now,
    };
    const ctx = loadContext(masters);
    const invalid = checkDefinition(def, ctx);
    if (invalid !== undefined) return err(invalid);
    const confirm = confirmRequired(def, recurring, ctx, today, input.confirm);
    if (confirm !== undefined) return err(confirm);

    recurring.insertRecurring(def);
    recurring.appendRecurringAudit(
      auditEntry(deps, {
        targetType: "recurring_journal",
        targetId: def.id,
        action: "create",
        after: def,
        at: now,
      }),
    );
    return ok(def);
  });
}

/**
 * 定義を変更する（行は全件置き換え、`version` +1）。`version` が古ければ `VERSION_CONFLICT`。
 * 変更は未登録の回にだけ効く（FR-026）。保存で登録される回が増えるときは確認を求める
 */
export function updateRecurring(
  deps: RecurringDeps,
  id: string,
  input: RecurringUpdate,
  today: string,
): Result<Recurring> {
  return deps.uow.run(({ masters, recurring }) => {
    const before = recurring.getRecurring(id);
    if (before === null) return notFound(id);
    if (before.version !== input.version) return versionConflict(before);

    const now = deps.clock.now();
    const after: Recurring = {
      ...before,
      name: input.name.trim(),
      memo: trimToNull(input.memo),
      dayOfMonth: input.dayOfMonth,
      startMonth: input.startMonth,
      endMonth: input.endMonth ?? null,
      version: before.version + 1,
      lines: toLines(input.lines),
      updatedAt: now,
    };
    const ctx = loadContext(masters);
    const invalid = checkDefinition(after, ctx);
    if (invalid !== undefined) return err(invalid);
    const confirm = confirmRequired(after, recurring, ctx, today, input.confirm);
    if (confirm !== undefined) return err(confirm);

    recurring.updateRecurring(after);
    recurring.appendRecurringAudit(
      auditEntry(deps, {
        targetType: "recurring_journal",
        targetId: id,
        action: "update",
        before,
        after,
        at: now,
      }),
    );
    return ok(after);
  });
}

/** 停止する（`status = paused`）。すでに停止中なら何も書かずにそのまま返す */
export function pauseRecurring(
  deps: RecurringDeps,
  id: string,
  input: PauseInput,
): Result<Recurring> {
  return deps.uow.run(({ recurring }) => {
    const before = recurring.getRecurring(id);
    if (before === null) return notFound(id);
    if (before.version !== input.version) return versionConflict(before);
    if (before.status === "paused") return ok(before);

    const now = deps.clock.now();
    const after: Recurring = {
      ...before,
      status: "paused",
      version: before.version + 1,
      updatedAt: now,
    };
    recurring.updateRecurring(after);
    recurring.appendRecurringAudit(
      auditEntry(deps, {
        targetType: "recurring_journal",
        targetId: id,
        action: "pause",
        before,
        after,
        at: now,
      }),
    );
    return ok(after);
  });
}

/**
 * 再開する（R20）。`start_month = max(start_month, fromMonth)`（`fromMonth` の既定は今日の月）なので、
 * 停止の間の回と、再開の月より前の回は登録しない。再開の月が終了月より後なら `VALIDATION`（`fromMonth`）。
 * 再開で今日以前に登録される回があれば確認を求める（FR-029）
 */
export function resumeRecurring(
  deps: RecurringDeps,
  id: string,
  input: ResumeInput,
  today: string,
): Result<Recurring> {
  return deps.uow.run(({ masters, recurring }) => {
    const before = recurring.getRecurring(id);
    if (before === null) return notFound(id);
    if (before.version !== input.version) return versionConflict(before);
    if (before.status !== "paused") {
      return validation("停止中の定期仕訳だけ再開できます", { field: "status" });
    }

    const fromMonth = input.fromMonth ?? monthOfDate(today);
    const startMonth = before.startMonth >= fromMonth ? before.startMonth : fromMonth;
    if (before.endMonth !== null && startMonth > before.endMonth) {
      return validation("再開の月が終了月より後です", { field: "fromMonth" });
    }
    const now = deps.clock.now();
    const after: Recurring = {
      ...before,
      status: "active",
      startMonth,
      version: before.version + 1,
      updatedAt: now,
    };
    const confirm = confirmRequired(after, recurring, loadContext(masters), today, input.confirm);
    if (confirm !== undefined) return err(confirm);

    recurring.updateRecurring(after);
    recurring.appendRecurringAudit(
      auditEntry(deps, {
        targetType: "recurring_journal",
        targetId: id,
        action: "resume",
        before,
        after,
        at: now,
      }),
    );
    return ok(after);
  });
}

const toRunView = (run: RecurringRunRecord): RecurringRunView => ({
  targetMonth: run.targetMonth,
  status: run.status,
  journalId: run.journalId,
  skipReason: run.skipReason,
  createdAt: run.createdAt,
});

/**
 * 「この回は登録しない」を確定する（FR-027）。対象は、予定日が今日以前で `posted`・`skipped` でない回
 * （`blocked` を含む未登録の回）。対象外の月は `VALIDATION`（`details.field = "month"`）。
 * 理由は 001 の `checkReason`（`REASON_REQUIRED`）。以後の判定で登録されない
 */
export function skipRecurringRun(
  deps: RecurringDeps,
  id: string,
  month: string,
  input: SkipRunInput,
  today: string,
): Result<RecurringRunView> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;
  return deps.uow.run(({ recurring }) => {
    const def = recurring.getRecurring(id);
    if (def === null) return notFound(id);
    const invalidMonth = (message: string) => validation(message, { field: "month", month });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      return invalidMonth("月は YYYY-MM で指定してください");
    if (month < def.startMonth || (def.endMonth !== null && month > def.endMonth)) {
      return invalidMonth("この定期仕訳の対象の月ではありません");
    }
    if (scheduledDate(month, def.dayOfMonth) > today) {
      return invalidMonth("予定日がまだ来ていない月は飛ばせません");
    }
    if (doneMonthsOf(recurring, id).includes(month)) {
      return invalidMonth("登録済み、または飛ばし済みの月です");
    }

    const now = deps.clock.now();
    const run: RecurringRunRecord = {
      id: deps.ids.next(),
      recurringId: id,
      targetMonth: month,
      status: "skipped",
      journalId: null,
      skipReason: reason.value,
      createdAt: now,
      acknowledgedAt: null,
    };
    recurring.insertRun(run);
    recurring.appendRecurringAudit(
      auditEntry(deps, {
        targetType: "recurring_run",
        targetId: run.id,
        action: "skip",
        reason: reason.value,
        after: run,
        at: now,
      }),
    );
    return ok(toRunView(run));
  });
}

export type PostedRecurringRun = { recurringId: string; targetMonth: string; journal: Journal };
export type FailedRecurringRun = { recurringId: string; targetMonth: string; error: DomainError };
export type PostDueResult = { posted: PostedRecurringRun[]; failed: FailedRecurringRun[] };

/**
 * 予定日が今日以前の未登録の回を、すべてその予定日付で登録する（FR-024、INV-35）。
 * 定義ごとに `planRecurringRuns` で回を決め、回ごとに 1 トランザクションで
 * `createJournal(…, { source: "recurring" })` → `recurring_runs`（`posted`）→ 記録、の順に書く（R9・R19）。
 * 回の保存の失敗（UNIQUE の違反など）は例外で、その回の仕訳も巻き戻る。仕訳の検査の違反は `failed` に入れて続ける
 */
export function postDueRecurring(deps: RecurringDeps, today: string): PostDueResult {
  const result: PostDueResult = { posted: [], failed: [] };
  const plans = deps.uow.run(({ masters, recurring }) => {
    const ctx = loadContext(masters);
    return ok(
      recurring.listRecurring().map((def) => ({
        def,
        plan: planRecurringRuns({ def, today, doneMonths: doneMonthsOf(recurring, def.id), ctx }),
      })),
    );
  });
  if (!plans.ok) return result; // 読み取りだけなので err にはならない

  for (const { def, plan } of plans.value) {
    for (const item of plan.post) {
      const posted = deps.uow.run(({ ledger, masters, recurring }) => {
        // 同じ回が先に登録されていたら何もしない（UNIQUE が最後の砦。R19）
        if (doneMonthsOf(recurring, def.id).includes(item.month)) return ok(null);
        const created = createJournal(
          { ledger, masters, ids: deps.ids, clock: deps.clock },
          item.draft,
          { source: "recurring" },
        );
        if (!created.ok) return created;
        const journal = created.value.journal;
        const now = deps.clock.now();
        const run: RecurringRunRecord = {
          id: deps.ids.next(),
          recurringId: def.id,
          targetMonth: item.month,
          status: "posted",
          journalId: journal.id,
          skipReason: null,
          createdAt: now,
          acknowledgedAt: null,
        };
        recurring.insertRun(run);
        recurring.appendRecurringAudit(
          auditEntry(deps, {
            targetType: "recurring_run",
            targetId: run.id,
            action: "create",
            after: run,
            at: now,
          }),
        );
        return ok(journal);
      });
      if (!posted.ok) {
        result.failed.push({ recurringId: def.id, targetMonth: item.month, error: posted.error });
      } else if (posted.value !== null) {
        result.posted.push({
          recurringId: def.id,
          targetMonth: item.month,
          journal: posted.value,
        });
      }
    }
  }
  return result;
}

/** 計画の `blocked` を応答の形（定義の名前つき）にする */
function toBlockedRuns(def: Recurring, plan: RecurringPlan): BlockedRun[] {
  return plan.blocked.map((b) => ({
    recurringId: def.id,
    name: def.name,
    targetMonth: b.month,
    date: b.date,
    reason: b.reason,
    ...(b.details === undefined ? {} : { details: b.details }),
  }));
}

/**
 * 画面の知らせ（R21）: 未確認の自動登録の回（`posted` で `acknowledged_at` が NULL）と、
 * 登録できない回（`blocked`。判定のたびに計算する）
 */
export function recurringStatus(
  deps: RecurringDeps,
  today: string,
): Result<RecurringStatusResponse> {
  return deps.uow.run(({ ledger, masters, recurring }) => {
    const defs = recurring.listRecurring();
    const names = new Map(defs.map((d) => [d.id, d.name]));
    const unacknowledged: RecurringStatusResponse["unacknowledged"] = [];
    for (const run of recurring.listRuns()) {
      if (run.status !== "posted" || run.acknowledgedAt !== null || run.journalId === null)
        continue;
      const journal = ledger.getJournal(run.journalId);
      if (journal === undefined) continue;
      unacknowledged.push({
        runId: run.id,
        recurringId: run.recurringId,
        name: names.get(run.recurringId) ?? "",
        targetMonth: run.targetMonth,
        journal: {
          id: journal.id,
          journalNo: journal.journalNo,
          date: journal.date,
          status: journal.status,
        },
      });
    }
    const ctx = loadContext(masters);
    const blocked = defs.flatMap((def) =>
      toBlockedRuns(
        def,
        planRecurringRuns({ def, today, doneMonths: doneMonthsOf(recurring, def.id), ctx }),
      ),
    );
    return ok({ unacknowledged, blocked });
  });
}

/**
 * 自動で登録した回を「確認した」にする（`acknowledged_at` を付ける）。存在しない・`posted` でない回の ID が
 * 1 つでもあれば `VALIDATION`（`details.field = "runIds"`）で何も変えない。確認済みの回は何もしない
 */
export function acknowledgeRuns(deps: RecurringDeps, runIds: string[]): Result<null> {
  return deps.uow.run(({ recurring }) => {
    const runs = new Map(recurring.listRuns().map((r) => [r.id, r]));
    for (const runId of runIds) {
      const run = runs.get(runId);
      if (run === undefined || run.status !== "posted") {
        return validation("確認できる回が見つかりません", { field: "runIds", runId });
      }
    }
    const targets = [...new Set(runIds)]
      .map((runId) => runs.get(runId))
      .filter((r): r is RecurringRunRecord => r !== undefined && r.acknowledgedAt === null);
    if (targets.length === 0) return ok(null);

    const now = deps.clock.now();
    recurring.markRunsAcknowledged(
      targets.map((r) => r.id),
      now,
    );
    for (const run of targets) {
      recurring.appendRecurringAudit(
        auditEntry(deps, {
          targetType: "recurring_run",
          targetId: run.id,
          action: "acknowledge",
          before: run,
          after: { ...run, acknowledgedAt: now },
          at: now,
        }),
      );
    }
    return ok(null);
  });
}

/**
 * 次の予定日: 停止中・終了月を過ぎたら null。そうでなければ、今日より後の最初の予定日
 * （開始月より前なら開始月の予定日）
 */
function nextDate(def: Recurring, today: string): string | null {
  if (def.status === "paused") return null;
  let index = Math.max(monthIndex(def.startMonth), monthIndex(monthOfDate(today)));
  for (let step = 0; step < 2; step++, index++) {
    const year = Math.floor(index / 12);
    const month = `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
    if (def.endMonth !== null && month > def.endMonth) return null;
    const date = scheduledDate(month, def.dayOfMonth);
    if (date > today) return date;
  }
  return null;
}

/** 一覧（H:§5.1）: 定義に次の予定日と登録済みの件数を添える */
export function listRecurring(deps: RecurringDeps, today: string): Result<RecurringView[]> {
  return deps.uow.run(({ recurring }) => {
    const runs = recurring.listRuns();
    return ok(
      recurring.listRecurring().map((def) => ({
        ...def,
        nextDate: nextDate(def, today),
        postedCount: runs.filter((r) => r.recurringId === def.id && r.status === "posted").length,
      })),
    );
  });
}

/** 詳細（H:§5.3）: 定義、回（登録・飛ばした）、登録できない回 */
export function getRecurringDetail(
  deps: RecurringDeps,
  id: string,
  today: string,
): Result<RecurringDetailResponse> {
  return deps.uow.run(({ masters, recurring }) => {
    const def = recurring.getRecurring(id);
    if (def === null) return notFound(id);
    const runs = recurring.listRuns(id);
    const plan = planRecurringRuns({
      def,
      today,
      doneMonths: runs.map((r) => r.targetMonth),
      ctx: loadContext(masters),
    });
    return ok({ recurring: def, runs: runs.map(toRunView), blocked: toBlockedRuns(def, plan) });
  });
}
