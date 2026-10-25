import type { BlockedReason } from "@trebuchet/schema";

/** 予定日の表示。31 は「末日」（H:§5。29・30 は選べない） */
export const dayLabel = (dayOfMonth: number) =>
  dayOfMonth === 31 ? "毎月末日" : `毎月 ${dayOfMonth} 日`;

/** 予定日の選択肢（1〜28 と末日 = 31） */
export const DAY_OPTIONS: { value: number; label: string }[] = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: `${i + 1} 日` })),
  { value: 31, label: "末日" },
];

/** 期間の表示。終了月がなければ「2026-08 から」 */
export const periodLabel = (startMonth: string, endMonth: string | null) =>
  endMonth === null ? `${startMonth} から` : `${startMonth} 〜 ${endMonth}`;

export const STATUS_LABELS = { active: "有効", paused: "停止中" } as const;

/** 「この回は登録しない」の理由が `JOURNAL_INVALID` のとき、001 の検証が返した元のコードで案内する */
const INVALID_CODE_MESSAGES: Record<string, string> = {
  TAX_SETTING_GAP: "消費税の設定の期間に空白または重複があるため登録できません。",
  TAX_METHOD_UNSUPPORTED: "この日付の消費税の計算方法には未対応のため登録できません。",
  VALIDATION: "使用停止の補助科目があるため登録できません。",
};

const REASON_MESSAGES: Record<Exclude<BlockedReason, "JOURNAL_INVALID">, string> = {
  PERIOD_CLOSED: "締め済みの会計期間のため登録できません。",
  OUT_OF_PERIOD: "予定日を含む会計期間がないため登録できません。",
  ACCOUNT_INACTIVE: "使用停止の勘定科目があるため登録できません。",
  ACCOUNT_NOT_FOUND: "勘定科目が見つからないため登録できません。",
  PARTNER_INACTIVE: "使用停止の取引先があるため登録できません。",
};

/** 登録できなかった回の理由の文言 */
export function blockedMessage(reason: BlockedReason, code?: string): string {
  if (reason !== "JOURNAL_INVALID") return REASON_MESSAGES[reason];
  return (
    (code === undefined ? undefined : INVALID_CODE_MESSAGES[code]) ??
    `仕訳の検査に通らないため登録できません${code === undefined ? "" : `（${code}）`}。`
  );
}
