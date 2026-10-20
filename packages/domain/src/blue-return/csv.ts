import type { BlueReturn } from "@trebuchet/schema";
import { type CsvValue, encodeCsv } from "../reports/csv.ts";
import { formForYear } from "./form.ts";

/**
 * 決算書を CSV にする（research R14）。列は `ページ,欄番号,欄名,金額`。
 * いまは1ページの欄だけを出す（2〜4ページの行は後のタスクで足す）。
 * 金額が null（回答待ち）の欄は空。blankUnused なら、様式で kind = unused の欄の金額を空にする
 * （選択は保存せず、出力のときだけ切り替える）。書き方は 001 の帳票の CSV（encodeCsv）と同じ
 */
export function blueReturnToCsv(blueReturn: BlueReturn, options: { blankUnused: boolean }): string {
  const form = formForYear(blueReturn.formYear);
  const unused = new Set(form.pl.filter((l) => l.kind === "unused").map((l) => l.no));
  const rows: CsvValue[][] = [
    ["ページ", "欄番号", "欄名", "金額"],
    ...blueReturn.page1.lines.map((l) => [
      1,
      l.no,
      l.label,
      options.blankUnused && unused.has(l.no) ? "" : l.amount,
    ]),
  ];
  return encodeCsv(rows);
}
