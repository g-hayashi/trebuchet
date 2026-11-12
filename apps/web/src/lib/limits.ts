/**
 * 入力欄の文字数の上限のうち、`@trebuchet/schema` に名前つきの定数がないもの。
 * 値は schema の検証と同じ（変えるときは schema に合わせる）
 */

/** 訂正・取消・締めの解除などの理由 */
export const REASON_MAX = 500;
/** 証憑のメモ */
export const RECEIPT_MEMO_MAX = 500;
/** 取込ルールの摘要（テンプレート） */
export const RULE_DESCRIPTION_MAX = 500;
/** 取込元（口座）の名前 */
export const SOURCE_NAME_MAX = 100;
/** 仕訳のメモ（摘要） */
export const JOURNAL_MEMO_MAX = 1000;
