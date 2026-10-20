import type { FiledDocumentKind, TaxReturnMemoKind } from "@trebuchet/schema";

/** 事業所得以外の控えの種類の表示名（data-model §1.8） */
export const MEMO_KIND_LABELS: Record<TaxReturnMemoKind, string> = {
  salary: "給与所得",
  social_insurance: "社会保険料控除",
  small_business_mutual_aid: "小規模企業共済等掛金控除",
  life_insurance: "生命保険料控除",
  earthquake_insurance: "地震保険料控除",
  donation: "寄附金控除",
  medical: "医療費控除",
  stocks: "株式等の譲渡・配当",
  crypto: "暗号資産",
  foreign_tax_credit: "外国税額控除",
  other: "その他",
};

/** 提出書類の種類の表示名（data-model §1.9） */
export const DOCUMENT_KIND_LABELS: Record<FiledDocumentKind, string> = {
  blue_return: "青色申告決算書",
  tax_return: "確定申告書",
  attachment: "添付書類",
  other: "その他",
};

export const MEMO_KINDS = Object.keys(MEMO_KIND_LABELS) as TaxReturnMemoKind[];
export const DOCUMENT_KINDS = Object.keys(DOCUMENT_KIND_LABELS) as FiledDocumentKind[];

/** 一覧の種類の列。項目名があれば添える（「その他（ふるさと納税）」） */
export const memoKindText = (kind: TaxReturnMemoKind, label: string | null): string =>
  label ? `${MEMO_KIND_LABELS[kind]}（${label}）` : MEMO_KIND_LABELS[kind];

export const FILE_PATH_ERROR = "ファイルの場所は絶対パス（/ で始まる）で入力してください";
