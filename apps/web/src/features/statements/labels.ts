import type {
  CandidateMethod,
  Purpose,
  RuleHistoryAction,
  RuleStatus,
  StatementAccountKind,
  StatementAccountUsage,
  StatementAmountSign,
  StatementColumnRole,
  StatementDelimiter,
  StatementEncoding,
  StatementOrigin,
  StatementStatus,
  StatementStatusFilter,
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
  file: "ファイル",
};

/** 列の役割（007 data-model §3）。必須は日付・内容と、金額か出金・入金 */
export const ROLE_LABELS: Record<StatementColumnRole, string> = {
  date: "日付",
  content: "内容",
  amount: "金額",
  outflow: "出金",
  inflow: "入金",
  accountName: "口座名",
  categoryMajor: "大項目",
  categoryMinor: "中項目",
  memo: "メモ",
  externalId: "取引の識別",
  transferFlag: "振替",
};

export const DELIMITER_LABELS: Record<StatementDelimiter, string> = {
  "\t": "タブ",
  ",": "カンマ",
  ";": "セミコロン",
};

export const ENCODING_LABELS: Record<StatementEncoding, string> = {
  "utf-8": "UTF-8",
  shift_jis: "CP932（shift_jis）",
};

export const AMOUNT_SIGN_LABELS: Record<StatementAmountSign, string> = {
  inflow_positive: "正の値は入金",
  outflow_positive: "正の値は出金",
};

export const STATUS_LABELS: Record<StatementStatus, string> = {
  unprocessed: "未処理",
  registered: "登録済み",
  excluded: "除外",
};

/** 一覧の絞り込みの選択肢（`status` が空は「すべて」） */
export const STATUS_FILTER_OPTIONS: { value: StatementStatusFilter | ""; label: string }[] = [
  { value: "unprocessed", label: "未処理" },
  { value: "registered", label: "登録済み" },
  { value: "excluded", label: "除外" },
  { value: "changed", label: "変更あり" },
  { value: "", label: "すべて" },
];

/** 候補の判定の方法（006/R8） */
export const METHOD_LABELS: Record<CandidateMethod, string> = {
  match: "既存の仕訳と一致",
  transfer: "振替の対",
  rule: "ルール",
  local_ai: "端末内の AI",
  external_ai: "外部の AI",
  none: "候補なし",
};

/** 判定（事業／私用） */
export const PURPOSE_LABELS: Record<Purpose, string> = {
  business: "事業",
  private: "私用",
};

export const RULE_STATUS_LABELS: Record<RuleStatus, string> = {
  active: "有効",
  paused: "停止中",
};

/** ルールの履歴の操作（`inference_rule_history.action`） */
export const RULE_ACTION_LABELS: Record<RuleHistoryAction, string> = {
  create: "作成",
  update: "承認で更新",
  edit: "編集",
  pause: "停止",
  resume: "再開",
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
