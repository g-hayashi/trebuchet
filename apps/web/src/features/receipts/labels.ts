import type {
  ReceiptCategory,
  ReceiptChannel,
  ReceiptHistoryAction,
  ReceiptLinkState,
  ReceiptMediaType,
  ReceiptWarning,
} from "@trebuchet/schema";

// 証憑の表示名（E1）。識別子は schema の値のまま、表示名はここの 1 か所だけに置く

export const CATEGORY_LABELS: Record<ReceiptCategory, string> = {
  paper_scan: "紙を撮影（原本は保存）",
  electronic: "電子取引",
};

/** 区分の選択肢（表示の順） */
export const CATEGORY_OPTIONS: ReceiptCategory[] = ["paper_scan", "electronic"];

/** 「紙を撮影」を選んだときと、保存・解像度などの警告に添える注記 */
export const KEEP_ORIGINAL_NOTE = "紙の原本は捨てずに保存する";

export const CHANNEL_LABELS: Record<ReceiptChannel, string> = {
  local: "この Mac から",
  remote: "外部から（スマホなど）",
};

export const LINK_STATE_LABELS: Record<ReceiptLinkState, string> = {
  none: "結びつきなし",
  linked: "仕訳に結びつき",
  journal_voided: "仕訳が取消済み",
};

/** 検索の「結びつき」の選択肢の表示名 */
export const LINK_FILTER_LABELS: Record<ReceiptLinkState, string> = {
  none: "仕訳なし",
  linked: "仕訳あり",
  journal_voided: "仕訳が取消済み",
};

export const MEDIA_TYPE_LABELS: Record<ReceiptMediaType, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/heic": "HEIC",
  "application/pdf": "PDF",
};

const num = (value: unknown): string => (typeof value === "number" ? String(value) : "?");

/**
 * 警告の短い文（一覧用）。期限などの日付は server の応答（`details`）をそのまま表示する
 * （web では日付を計算しない。I2）
 */
export function warningLabel(warning: ReceiptWarning): string {
  const details = warning.details ?? {};
  switch (warning.code) {
    case "FIELDS_MISSING":
      return "未入力の項目があります";
    case "INPUT_PERIOD_EXCEEDED":
      return `入力の期限（${typeof details.deadline === "string" ? details.deadline : "?"}）を過ぎています`;
    case "RESOLUTION_BELOW_GUIDE":
      return `解像度が目安（長辺 ${num(details.minLong)}px・短辺 ${num(details.minShort)}px 以上）に届いていません（${num(details.width)}×${num(details.height)}）`;
    case "NOT_FULL_COLOR":
      return "フルカラーではありません（グレースケールの可能性があります）";
    case "JOURNAL_VOIDED":
      return "結びついた仕訳が取り消されています";
  }
}

/** 紙の原本を残す注意を添える警告（入力期間・解像度・階調） */
const NEEDS_ORIGINAL_NOTE: ReadonlySet<ReceiptWarning["code"]> = new Set([
  "INPUT_PERIOD_EXCEEDED",
  "RESOLUTION_BELOW_GUIDE",
  "NOT_FULL_COLOR",
]);

/** 警告の文（追加の結果・詳細用）。入力期間・解像度・階調の警告には「紙の原本は捨てずに保存する」を添える */
export function warningText(warning: ReceiptWarning): string {
  const label = warningLabel(warning);
  return NEEDS_ORIGINAL_NOTE.has(warning.code) ? `${label}。${KEEP_ORIGINAL_NOTE}。` : label;
}

/** 履歴の操作の表示名（`receipt_audit_log` の `action`。US5） */
export const HISTORY_ACTION_LABELS: Record<ReceiptHistoryAction, string> = {
  create: "追加",
  update: "訂正",
  replace_file: "ファイルを差し替え",
  delete: "削除",
  link: "仕訳に結びつけ",
  unlink: "結びつきを解除",
  read: "AI の読み取り",
};

/** 訂正の前後を比べる値の表示名（表示の順） */
export const HISTORY_VALUE_LABELS = {
  category: "区分",
  transactionDate: "取引年月日",
  amount: "金額",
  partnerName: "取引先",
  memo: "メモ",
} as const;

/** ファイルの大きさ（バイト数を 3 桁区切りで） */
export const formatBytes = (bytes: number): string => `${bytes.toLocaleString("ja-JP")} バイト`;
