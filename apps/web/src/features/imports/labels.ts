import type {
  ImportBatchStatus,
  ImportDecision,
  ImportReasonCode,
  ImportWarningCode,
  MappingStatus,
} from "@trebuchet/schema";

// 取込の判定・理由・警告などのコードの日本語の表示（画面はすべてここを使う。data-model §3）

export const DECISION_LABELS: Record<ImportDecision, string> = {
  new: "新規",
  already: "取込済み",
  excluded: "対象外",
  rejected: "取込不可",
};

export const REASON_LABELS: Record<ImportReasonCode, string> = {
  PRIOR_YEAR_CLOSING: "前年の決算整理（期首残高に反映済み）",
  YEAR_NOT_SELECTED: "取り込む年度に選ばれていない",
  USER_EXCLUDED: "個別に外した",
  UNBALANCED: "借方と貸方の合計が合わない",
  INVALID_AMOUNT: "金額が正の整数でない",
  MISSING_FIELD: "必須の項目が欠けている",
  LINE_COUNT_MISMATCH: "行の数が freee の仕訳行数と合わない",
  OUT_OF_PERIOD: "日付がどの会計期間にも入らない",
  PERIOD_CLOSED: "締め済みの年度のため取り込めない",
  UNMAPPED: "対応表で対応が決まっていない名前がある",
  ACCOUNT_INACTIVE: "対応先の科目が使用停止",
  ALREADY_IMPORTED: "取り込み済み",
};

export const WARNING_LABELS: Record<ImportWarningCode, string> = {
  TAX_AMOUNT_MISMATCH: "税額が計算と違う",
  TAX_CATEGORY_SUSPICIOUS: "税区分が科目と合わない可能性",
  POSSIBLE_DUPLICATE: "二重登録の可能性",
  FREEE_CHANGED: "freee 側で変更あり",
  FREEE_DELETED: "freee 側で削除",
  NEGATIVE_OPENING: "期首残高がマイナス",
  OPENING_DIFFERS_FROM_CARRY_FORWARD: "前年度の繰越と違う",
};

export const MAPPING_STATUS_LABELS: Record<MappingStatus, string> = {
  saved: "保存済み",
  proposed: "案",
  unmapped: "未定",
};

export const BATCH_STATUS_LABELS: Record<ImportBatchStatus, string> = {
  active: "有効",
  voided: "取消済み",
};
