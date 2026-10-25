import { z } from "zod";
import { JournalLineInput, JournalRef } from "./journals.ts";
import {
  DateString,
  DayOfMonthOrEnd,
  Id,
  MonthString,
  Side,
  TaxCategoryCode,
  YEN_LIMIT,
} from "./primitives.ts";

// 005-recurring-invoicing（contracts/http-api.md §5）

const Timestamp = z.string().min(1);
const Version = z.number().int().positive();

/** `YYYY-MM` の大小（同じ桁なので文字列比較でよい） */
const endNotBeforeStart = (v: { startMonth: string; endMonth?: string | undefined }) =>
  v.endMonth === undefined || v.endMonth >= v.startMonth;

const endMonthIssue = {
  message: "終了月は開始月以降にしてください",
  path: ["endMonth"],
};

/** 定義の項目（confirm・version を除く）。借方と貸方の一致はドメインが 001 の `validateJournal` で検査する */
const RecurringFields = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(100),
  memo: z.string().max(1000).optional(),
  dayOfMonth: DayOfMonthOrEnd,
  startMonth: MonthString,
  endMonth: MonthString.optional(),
  lines: z
    .array(JournalLineInput)
    .min(2, "行は2行以上入力してください")
    .max(100, "行は100行までです"),
});

/** POST /recurring-journals。`confirm` は今日以前に登録される回があるときの確認（FR-029） */
export const RecurringInput = RecurringFields.extend({ confirm: z.boolean().optional() }).refine(
  endNotBeforeStart,
  endMonthIssue,
);
export type RecurringInput = z.infer<typeof RecurringInput>;

/** PUT /recurring-journals/:id（楽観ロックの `version` が必須） */
export const RecurringUpdate = RecurringFields.extend({
  version: Version,
  confirm: z.boolean().optional(),
}).refine(endNotBeforeStart, endMonthIssue);
export type RecurringUpdate = z.infer<typeof RecurringUpdate>;

/** POST /recurring-journals/:id/pause */
export const PauseInput = z.object({ version: Version });
export type PauseInput = z.infer<typeof PauseInput>;

/** POST /recurring-journals/:id/resume。`fromMonth` の既定は今日の月（R20） */
export const ResumeInput = z.object({
  version: Version,
  fromMonth: MonthString.optional(),
  confirm: z.boolean().optional(),
});
export type ResumeInput = z.infer<typeof ResumeInput>;

/** POST /recurring-journals/:id/runs/:month/skip。空欄の判定はドメインで行う */
export const SkipRunInput = z.object({ reason: z.string() });
export type SkipRunInput = z.infer<typeof SkipRunInput>;

/** POST /recurring-journals/acknowledge */
export const AcknowledgeInput = z.object({ runIds: z.array(Id).min(1) });
export type AcknowledgeInput = z.infer<typeof AcknowledgeInput>;

// ---- 応答 ----

export const RecurringStatus = z.enum(["active", "paused"]);
export type RecurringStatus = z.infer<typeof RecurringStatus>;

export const RecurringLineView = z.object({
  lineNo: z.number().int().positive(),
  side: Side,
  accountId: Id,
  subAccountId: Id.nullable(),
  amount: z.number().int().positive().lt(YEN_LIMIT),
  taxCategory: TaxCategoryCode.nullable(),
  partnerId: Id.nullable(),
  description: z.string().nullable(),
});
export type RecurringLineView = z.infer<typeof RecurringLineView>;

/** 定義（行を含む） */
export const Recurring = z.object({
  id: Id,
  name: z.string(),
  memo: z.string().nullable(),
  dayOfMonth: DayOfMonthOrEnd,
  startMonth: MonthString,
  endMonth: MonthString.nullable(),
  status: RecurringStatus,
  version: Version,
  lines: z.array(RecurringLineView),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Recurring = z.infer<typeof Recurring>;

/** 一覧の 1 件（定義 ＋ 次の予定日と登録済みの件数） */
export const RecurringView = Recurring.extend({
  nextDate: DateString.nullable(),
  postedCount: z.number().int().nonnegative(),
});
export type RecurringView = z.infer<typeof RecurringView>;

export const RecurringListResponse = z.object({ recurring: z.array(RecurringView) });
export type RecurringListResponse = z.infer<typeof RecurringListResponse>;

/** POST・PUT・resume の応答。保存の直後に走らせた判定で登録された仕訳 */
export const RecurringSavedResponse = z.object({
  recurring: Recurring,
  posted: z.array(JournalRef),
});
export type RecurringSavedResponse = z.infer<typeof RecurringSavedResponse>;

export const RecurringRunStatus = z.enum(["posted", "skipped"]);
export type RecurringRunStatus = z.infer<typeof RecurringRunStatus>;

export const RecurringRunView = z.object({
  targetMonth: MonthString,
  status: RecurringRunStatus,
  journalId: Id.nullable(),
  skipReason: z.string().nullable(),
  createdAt: Timestamp,
});
export type RecurringRunView = z.infer<typeof RecurringRunView>;

/** 登録できない回の理由（保存しない計算上の値。data-model §1.9） */
export const BlockedReason = z.enum([
  "PERIOD_CLOSED",
  "OUT_OF_PERIOD",
  "ACCOUNT_INACTIVE",
  "ACCOUNT_NOT_FOUND",
  "PARTNER_INACTIVE",
  "JOURNAL_INVALID",
]);
export type BlockedReason = z.infer<typeof BlockedReason>;

export const BlockedRun = z.object({
  recurringId: Id,
  name: z.string(),
  targetMonth: MonthString,
  date: DateString,
  reason: BlockedReason,
  /** `JOURNAL_INVALID` のとき、001 の検証が返した元のエラーのコード */
  details: z.object({ code: z.string() }).optional(),
});
export type BlockedRun = z.infer<typeof BlockedRun>;

/** GET /recurring-journals/:id */
export const RecurringDetailResponse = z.object({
  recurring: Recurring,
  runs: z.array(RecurringRunView),
  blocked: z.array(BlockedRun),
});
export type RecurringDetailResponse = z.infer<typeof RecurringDetailResponse>;

/** POST /recurring-journals/:id/runs/:month/skip の 200 */
export const RecurringSkipResponse = z.object({ run: RecurringRunView });
export type RecurringSkipResponse = z.infer<typeof RecurringSkipResponse>;

/** GET /recurring-journals/status */
export const RecurringStatusResponse = z.object({
  unacknowledged: z.array(
    z.object({
      runId: Id,
      recurringId: Id,
      name: z.string(),
      targetMonth: MonthString,
      journal: JournalRef,
    }),
  ),
  blocked: z.array(BlockedRun),
});
export type RecurringStatusResponse = z.infer<typeof RecurringStatusResponse>;
