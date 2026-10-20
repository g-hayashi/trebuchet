import type { BlueReturn } from "@trebuchet/schema";
import { type CsvValue, encodeCsv } from "../reports/csv.ts";

type Page4Side = BlueReturn["page4"]["opening"];

/** 2ページ: 月別の売上（金額ごとに行を分ける）、地代家賃の内訳、控除の計算 */
function page2Rows(page: BlueReturn["page2"]): CsvValue[][] {
  const rows: CsvValue[][] = [];
  for (const m of page.monthly.months) {
    rows.push([2, `${m.month}月`, "売上", m.sales]);
    rows.push([2, `${m.month}月`, "雑収入", m.otherIncome]);
    rows.push([2, `${m.month}月`, "月計", m.total]);
  }
  const t = page.monthly.total;
  rows.push(
    [2, "計", "売上", t.sales],
    [2, "計", "雑収入", t.otherIncome],
    [2, "計", "計", t.total],
  );
  for (const [i, d] of page.rentDetails.entries()) {
    const name = `${d.payee}（${d.property}）`;
    rows.push([2, `内訳${i + 1}`, `${name}: 賃借料`, d.annualRent]);
    rows.push([2, `内訳${i + 1}`, `${name}: 必要経費算入額`, d.deductibleAmount]);
  }
  rows.push(
    [2, "控除上限", "青色申告特別控除の上限", page.deduction?.cap ?? null],
    [2, "控除額", "青色申告特別控除額", page.deduction?.amount ?? null],
  );
  return rows;
}

/** 3ページ: 売上先、減価償却費の計算（金額ごとに行を分ける）、特殊事情（金額でない唯一の行） */
function page3Rows(page: BlueReturn["page3"]): CsvValue[][] {
  const rows: CsvValue[][] = [];
  const partners = page.salesPartners;
  for (const [i, p] of partners.rows.entries()) rows.push([3, `売上先${i + 1}`, p.name, p.amount]);
  rows.push([3, "上記以外", "上記以外の売上先の計", partners.others]);
  rows.push([3, "計", "売上先の合計", partners.total]);
  for (const [i, d] of page.depreciation.entries()) {
    const no = `資産${i + 1}`;
    rows.push(
      [3, no, `${d.name}: 取得価額`, d.cost],
      [3, no, `${d.name}: 償却の基礎になる金額`, d.base],
      [3, no, `${d.name}: 本年分の普通償却費`, d.ordinary],
      [3, no, `${d.name}: 本年分の償却費合計`, d.total],
      // 割合は万分率で持つので、% に直して出す（5000 → 50）
      [3, no, `${d.name}: 事業専用割合（%）`, d.businessRatio / 100],
      [3, no, `${d.name}: 必要経費算入額`, d.deductible],
      [3, no, `${d.name}: 未償却残高`, d.closingBookValue],
    );
  }
  rows.push([3, "特殊事情", "本年中における特殊事情", page.specialCircumstances]);
  return rows;
}

/** 4ページ: 貸借対照表。欄番号に 期首:/期末: を付けて区別する */
function page4Rows(page: BlueReturn["page4"]): CsvValue[][] {
  const side = (prefix: string, bs: Page4Side): CsvValue[][] => [
    ...bs.assets.rows.map((r): CsvValue[] => [4, `${prefix}:${r.label}`, r.label, r.amount]),
    [4, `${prefix}:資産の部合計`, "資産の部合計", bs.assets.total],
    ...bs.liabilityEquity.rows.map((r): CsvValue[] => [
      4,
      `${prefix}:${r.label}`,
      r.label,
      r.amount,
    ]),
    [4, `${prefix}:負債・資本の部合計`, "負債・資本の部合計", bs.liabilityEquity.total],
  ];
  return [...side("期首", page.opening), ...side("期末", page.closing)];
}

/**
 * 決算書を CSV にする（research R14）。列は `ページ,欄番号,欄名,金額`。1〜4ページを順に出す。
 * - 1ページ: 欄番号 = 欄の番号、欄名 = 欄の名前
 * - 2〜4ページ: 欄番号 = 表の行の識別子（1月、内訳1、売上先1、資産1、期首:現金 など）、欄名 = 表示名。
 *   1行に複数の金額がある表は、金額ごとに行を分け、欄名に列名を添える
 * - 金額が null（回答待ち）の欄は空。金額でない行は3ページの `特殊事情`（金額の列にメモの本文）だけ
 * - blankUnused なら、1ページの kind = unused の欄の金額を空にする（選択は保存せず、出力のときだけ
 *   切り替える。2〜4ページは変えない）
 * 書き方は 001 の帳票の CSV（encodeCsv）と同じ
 */
export function blueReturnToCsv(blueReturn: BlueReturn, options: { blankUnused: boolean }): string {
  const rows: CsvValue[][] = [
    ["ページ", "欄番号", "欄名", "金額"],
    ...blueReturn.page1.lines.map((l) => [
      1,
      l.no,
      l.label,
      options.blankUnused && l.kind === "unused" ? "" : l.amount,
    ]),
    ...page2Rows(blueReturn.page2),
    ...page3Rows(blueReturn.page3),
    ...page4Rows(blueReturn.page4),
  ];
  return encodeCsv(rows);
}
