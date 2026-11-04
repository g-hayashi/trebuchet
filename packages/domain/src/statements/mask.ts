import type { StatementAccount } from "@trebuchet/schema";
import type { StatementRecord } from "../types.ts";

// AI に送る内容の組み立てとマスク（006 R11、INV-45）。端末内の AI にも外部の AI にも同じ形を送る。
// 送る項目は `buildAiPayload` の許可リストだけ。口座の名前・メモ・明細の ID・取引先の一覧は送らない

/** AI に送る明細の内容。ここにない項目は送らない */
export type AiPayload = {
  /** 場面。`buildPrompt` が指示文を分ける。AI へは送らない（明細の場面の中身は 006 のまま変えない） */
  scene: "statement";
  date: string;
  /** 金額の絶対値（向きは `direction`） */
  amount: number;
  direction: "in" | "out";
  /** `maskContent` を通した内容 */
  content: string;
  categoryMajor: string | null;
  categoryMinor: string | null;
  accountKind: StatementAccount["kind"];
  accountUsage: StatementAccount["usage"];
};

/** 仕訳の入力（かんたん入力）の摘要・金額から科目・税区分を推定するときの入力（011/R19） */
export type JournalEntryInput = { date: string; amount: number; memo: string };

/** 仕訳の入力の場面で AI に送る内容。摘要・金額・日付だけ（取引先の一覧・口座名は送らない） */
export type JournalEntryPayload = {
  scene: "journal_entry";
  date: string;
  amount: number;
  /** `maskContent` を通した摘要 */
  memo: string;
};

/** AI に送る内容（場面ごとの形） */
export type SuggestionPayload = AiPayload | JournalEntryPayload;

const TRANSFER_PREFIX = /^(\s*(?:振込|ﾌﾘｺﾐ|フリコミ|振替))([\s\S]*)$/u;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
// 区切りつきの電話番号（03-1234-5678、090-1234-5678、+81-3-1234-5678 など）
const PHONE = /\+?\p{Nd}{1,4}[-‐ー－−]\p{Nd}{2,4}[-‐ー－−]\p{Nd}{3,4}/gu;
const LONG_DIGITS = /\p{Nd}{4,}/gu;

/**
 * 内容のマスク（R11）: 振込・振替で始まるときは後ろ（名義）を `[名義]`、メールアドレス・電話番号の形を
 * `[連絡先]`、4 桁以上の数字の並び（全角を含む）を `####` にする。冪等
 */
export function maskContent(content: string): string {
  let text = content;
  const transfer = TRANSFER_PREFIX.exec(text);
  if (transfer !== null) {
    const [, prefix = "", rest = ""] = transfer;
    text = rest.trim() === "" ? text : `${prefix} [名義]`;
  }
  return text.replace(EMAIL, "[連絡先]").replace(PHONE, "[連絡先]").replace(LONG_DIGITS, "####");
}

/** AI に送る内容を、許可した項目だけで組み立てる（R11。口座の名前・メモ・ID は渡さない） */
export function buildAiPayload(
  statement: Pick<
    StatementRecord,
    "date" | "amount" | "content" | "categoryMajor" | "categoryMinor"
  >,
  account: Pick<StatementAccount, "kind" | "usage">,
): AiPayload {
  return {
    scene: "statement",
    date: statement.date,
    amount: Math.abs(statement.amount),
    direction: statement.amount > 0 ? "in" : "out",
    content: maskContent(statement.content),
    categoryMajor: statement.categoryMajor,
    categoryMinor: statement.categoryMinor,
    accountKind: account.kind,
    accountUsage: account.usage,
  };
}

/**
 * 仕訳の入力の場面で AI に送る内容を、許可した項目（日付・金額・マスクした摘要）だけで組み立てる（R19、INV-45）。
 * 入力に余分な項目（取引先・口座の名前など）があっても渡さない
 */
export function buildJournalEntryPayload(
  entry: Pick<JournalEntryInput, "date" | "amount" | "memo">,
): JournalEntryPayload {
  return {
    scene: "journal_entry",
    date: entry.date,
    amount: entry.amount,
    memo: maskContent(entry.memo),
  };
}
