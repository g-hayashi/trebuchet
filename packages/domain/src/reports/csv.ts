import type {
  BalanceSheet,
  Figure,
  GeneralLedger,
  JournalBook,
  ProfitAndLoss,
  Report,
  ReportSection,
  TrialBalance,
} from "@trebuchet/schema";

export type CsvValue = string | number | null | undefined;

const BOM = "\uFEFF";
const CRLF = "\r\n";

const SECTION_LABELS: Record<ReportSection, string> = {
  BS_ASSET: "資産",
  BS_LIABILITY: "負債",
  BS_EQUITY: "純資産",
  PL_SALES: "売上",
  PL_COGS: "売上原価",
  PL_EXPENSE: "経費",
  PL_OTHER: "その他の損益",
};

function field(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * 表を CSV にする（RFC 4180）。UTF-8 の BOM を付け（Excel で文字化けしないため）、各行は CRLF で終える。
 * カンマ・引用符・改行を含む値は引用符で囲み、引用符は二重にする。数値は区切りなしの整数
 */
export function encodeCsv(rows: readonly (readonly CsvValue[])[]): string {
  return BOM + rows.map((r) => r.map(field).join(",") + CRLF).join("");
}

const nonZero = (n: number) => (n === 0 ? "" : n);

function trialBalanceRows(r: TrialBalance): CsvValue[][] {
  return [
    ["コード", "勘定科目", "期首残高", "借方", "貸方", "期末残高"],
    ...r.rows.map((x) => [x.code, x.name, x.opening, x.debit, x.credit, x.closing]),
    ["", "合計", "", r.totals.debit, r.totals.credit, ""],
  ];
}

function journalBookRows(r: JournalBook): CsvValue[][] {
  const blank = (label: string, amount: number) => [
    "",
    "",
    label,
    "",
    "",
    "",
    amount,
    "",
    "",
    "",
    "",
  ];
  return [
    [
      "日付",
      "仕訳番号",
      "貸借",
      "勘定科目",
      "補助科目",
      "取引先",
      "金額",
      "税区分",
      "消費税額",
      "摘要",
      "メモ",
    ],
    ...r.entries.flatMap((e) =>
      e.lines.map((l) => [
        e.date,
        e.journalNo,
        l.side === "debit" ? "借方" : "貸方",
        l.accountName,
        l.subAccountName,
        l.partnerName,
        l.amount,
        l.taxCategory,
        l.taxAmount,
        l.description,
        e.memo,
      ]),
    ),
    blank("借方合計", r.totals.debit),
    blank("貸方合計", r.totals.credit),
  ];
}

function generalLedgerRows(r: GeneralLedger): CsvValue[][] {
  return [
    ["日付", "仕訳番号", "相手科目", "摘要", "借方", "貸方", "残高"],
    ["", "", "前期繰越", "", "", "", r.broughtForward],
    ...r.entries.map((e) => [
      e.date,
      e.journalNo,
      e.counterpart,
      e.description,
      nonZero(e.debit),
      nonZero(e.credit),
      e.balance,
    ]),
    ["", "", "合計", "", r.totals.debit, r.totals.credit, r.closing],
  ];
}

const figureCells = (f: Figure, compare: boolean): CsvValue[] =>
  compare ? [f.amount, f.previous, f.change] : [f.amount];

const sumFigures = (a: Figure, b: Figure): Figure => ({
  amount: a.amount + b.amount,
  ...(a.previous !== undefined && { previous: a.previous + (b.previous ?? 0) }),
  ...(a.change !== undefined && { change: a.change + (b.change ?? 0) }),
});

function profitAndLossRows(r: ProfitAndLoss): CsvValue[][] {
  const compare = r.previous !== null;
  return [
    ["区分", "欄", "勘定科目", "金額", ...(compare ? ["前年", "増減"] : [])],
    ...r.sections.flatMap((s) => {
      const label = SECTION_LABELS[s.section];
      return [
        ...s.rows.map((x) => [label, x.reportLine, x.name, ...figureCells(x, compare)]),
        [label, "", "計", ...figureCells(s.total, compare)],
      ];
    }),
    ["", "", "差引金額", ...figureCells(r.netIncome, compare)],
  ];
}

function balanceSheetRows(r: BalanceSheet): CsvValue[][] {
  const compare = r.previousAsOf !== null;
  return [
    ["区分", "勘定科目", "金額", ...(compare ? ["前年", "増減"] : [])],
    ...r.sections.flatMap((s) => {
      const label = SECTION_LABELS[s.section];
      const equity = s.section === "BS_EQUITY";
      return [
        ...s.rows.map((x) => [label, x.name, ...figureCells(x, compare)]),
        ...(equity ? [[label, "当期利益", ...figureCells(r.netIncome, compare)]] : []),
        [label, "計", ...figureCells(equity ? sumFigures(s.total, r.netIncome) : s.total, compare)],
      ];
    }),
    ["", "資産合計", ...figureCells(r.totalAssets, compare)],
    ["", "負債・純資産合計", ...figureCells(r.totalLiabilitiesAndEquity, compare)],
  ];
}

/** 帳票を CSV にする（FR-032） */
export function toCsv(report: Report): string {
  switch (report.kind) {
    case "trial-balance":
      return encodeCsv(trialBalanceRows(report));
    case "journal-book":
      return encodeCsv(journalBookRows(report));
    case "general-ledger":
      return encodeCsv(generalLedgerRows(report));
    case "profit-and-loss":
      return encodeCsv(profitAndLossRows(report));
    case "balance-sheet":
      return encodeCsv(balanceSheetRows(report));
  }
}
