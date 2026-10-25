import type {
  StatementAccountKind,
  StatementAccountUsage,
  StatementOrigin,
} from "@trebuchet/schema";

export const USAGE_LABELS: Record<StatementAccountUsage, string> = {
  business: "事業用",
  mixed: "事業と私用が混ざる",
  private: "私用（帳簿の外）",
};

export const KIND_LABELS: Record<StatementAccountKind, string> = {
  bank: "銀行",
  card: "カード",
  cash: "現金",
  other: "その他",
};

export const ORIGIN_LABELS: Record<StatementOrigin, string> = {
  paste: "貼り付け",
  mfme_fetch: "自動取得",
};

/** 変更ありの行の項目の名前（`changed.before`・`after` のキー） */
export const CONTENT_FIELD_LABELS: Record<string, string> = {
  accountName: "口座",
  date: "日付",
  amount: "金額",
  content: "内容",
  categoryMajor: "大項目",
  categoryMinor: "中項目",
  memo: "メモ",
};
