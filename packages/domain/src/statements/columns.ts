import type { StatementColumnIndexes, StatementColumnRole } from "@trebuchet/schema";

/**
 * 明細の表の見出しの辞書と、列の案（007/R4）。辞書は 1 か所の一覧なので、新しい取込元の見出しに出会ったらここだけを足す。
 * 比べるときは NFKC・空白の除去・括弧書き（`（円）` など）の除去・英字の小文字化をした完全一致（部分一致にしない。
 * 「お支払金額」と「お支払」を取り違えるため）。残高（「残高」「差引残高」）は役割に持たない（読まない）
 */
export const COLUMN_ROLE_NAMES = {
  date: ["日付", "利用日", "ご利用日", "取引日", "お取引日", "年月日", "取扱日", "計上日", "Date"],
  content: [
    "内容",
    "摘要",
    "取引内容",
    "お取引内容",
    "利用店名",
    "ご利用店名",
    "ご利用先",
    "利用先",
    "明細",
    "Description",
  ],
  amount: ["金額", "利用金額", "ご利用金額", "支払金額", "お支払金額", "取引金額", "Amount"],
  outflow: [
    "出金",
    "出金額",
    "お引出し",
    "お引出金額",
    "支払",
    "お支払",
    "引出額",
    "Debit",
    "Withdrawal",
  ],
  inflow: ["入金", "入金額", "お預入れ", "お預入金額", "お預り金額", "預入額", "Credit", "Deposit"],
  accountName: ["保有金融機関", "口座", "口座名", "金融機関", "カード名"],
  categoryMajor: ["大項目"],
  categoryMinor: ["中項目"],
  memo: ["メモ", "備考"],
  externalId: ["ID", "取引ID", "明細ID"],
  transferFlag: ["振替"],
} as const satisfies Record<StatementColumnRole, readonly string[]>;

/** 見出しの名前を比べる形にする: NFKC、空白の除去、括弧書きの除去、英字の小文字化 */
export function normalizeHeaderName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

const ROLE_OF_NAME: ReadonlyMap<string, StatementColumnRole> = new Map(
  (Object.keys(COLUMN_ROLE_NAMES) as StatementColumnRole[]).flatMap((role) =>
    COLUMN_ROLE_NAMES[role].map((name): [string, StatementColumnRole] => [
      normalizeHeaderName(name),
      role,
    ]),
  ),
);

/**
 * 見出しのセルから、役割ごとの列の番号（0 起点）の案を作る。辞書に当たらない列は案にしない。
 * 同じ役割に 2 列が当たれば左の列だけ。案は案であり、利用者が確かめて確定する（FR-004）
 */
export function suggestColumns(header: readonly string[]): StatementColumnIndexes {
  const suggested: StatementColumnIndexes = {};
  header.forEach((cell, index) => {
    const role = ROLE_OF_NAME.get(normalizeHeaderName(cell));
    if (role !== undefined && suggested[role] === undefined) suggested[role] = index;
  });
  return suggested;
}
