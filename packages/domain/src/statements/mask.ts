import type { StatementAccount } from "@trebuchet/schema";
import type { StatementRecord } from "../types.ts";

// AI に送る内容の組み立てとマスク（006 R11、INV-45）。端末内の AI にも外部の AI にも同じ形を送る。
// 送る項目は `buildAiPayload` の許可リストだけ。口座の名前・メモ・明細の ID・取引先の一覧は送らない

/** AI に送る明細の内容。ここにない項目は送らない */
export type AiPayload = {
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
