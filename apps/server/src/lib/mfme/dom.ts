import { MFME_COLUMNS, type PastedRow, parseMfmePaste } from "@trebuchet/domain";
import { MfmeFetchError } from "../jobs.ts";

/**
 * MF ME の画面（URL・DOM）の知識はこのファイルだけに置く（006 R13）。
 * **実画面の DOM は未解析なので、ここの値はすべて暫定**（T032 で実画面に合わせる）。
 * 直すのは `LOGIN_URL`・`cashFlowUrl`・`isLoggedInUrl`・`SELECTORS` だけで済むようにする
 */

export const LOGIN_URL = "https://moneyforward.com/sign_in";

/** 月（`YYYY-MM`）の入出金の画面の URL（暫定） */
export function cashFlowUrl(month: string): string {
  const [year, mon] = month.split("-");
  return `https://moneyforward.com/cf?year=${Number(year)}&month=${Number(mon)}`;
}

/** ログインを終えて MF ME のホーム側の画面にいるか（暫定: moneyforward.com で、サインインの画面でない） */
export function isLoggedInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "moneyforward.com" && !u.pathname.startsWith("/sign_in");
  } catch {
    return false;
  }
}

/** 行・列のセレクター（暫定）。`row` 以下のセレクターは行の中で探す */
export const SELECTORS = {
  /** 入出金の表（ないときは画面の形が違う） */
  table: "table#cf-detail-table",
  row: "table#cf-detail-table tbody tr.transaction_list",
  date: "td.date",
  content: "td.content",
  amount: "td.amount",
  accountName: "td.note",
  categoryMajor: "td.lctg",
  categoryMinor: "td.mctg",
  memo: "td.memo",
  /** 振替の行が持つクラス（行の `classList`） */
  transferClass: "transfer",
  /** 取引の ID を持つ行の属性。なければ `externalId` なし（取れるかは実画面の解析で決める。R13） */
  idAttribute: "data-transaction-id",
} as const;

/** 画面から読んだままの 1 行（文字列。解釈は `rawRowsToPasted`） */
export type RawRow = {
  date: string;
  content: string;
  amount: string;
  accountName: string;
  categoryMajor: string;
  categoryMinor: string;
  memo: string;
  transfer: boolean;
  externalId: string | null;
};

/** ブラウザの中で動く式（`document` の型をサーバーの tsconfig に持ち込まないため、文字列で渡す） */
const EXTRACT_EXPRESSION = `((s) => {
  const text = (el) => (el ? el.textContent || "" : "").replace(/\\s+/g, " ").trim();
  return Array.from(document.querySelectorAll(s.row)).map((tr) => {
    const cell = (selector) => text(tr.querySelector(selector));
    const id = tr.getAttribute(s.idAttribute);
    return {
      date: cell(s.date),
      content: cell(s.content),
      amount: cell(s.amount),
      accountName: cell(s.accountName),
      categoryMajor: cell(s.categoryMajor),
      categoryMinor: cell(s.categoryMinor),
      memo: cell(s.memo),
      transfer: tr.classList.contains(s.transferClass),
      externalId: id ? id.trim() : null,
    };
  });
})(${JSON.stringify(SELECTORS)})`;

/** `readCashFlowRows` が使うページの操作（Playwright の `Page` の一部） */
export type MfmeDomPage = {
  evaluate(expression: string): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { state?: "attached"; timeout?: number },
  ): Promise<unknown>;
};

const DOM_CHANGED_MESSAGE =
  "MF ME の画面の形が想定と違うため、読み取れませんでした。貼り付けで取り込んでください";
const domChanged = () => new MfmeFetchError("MFME_DOM_CHANGED", DOM_CHANGED_MESSAGE);

const HEADER = [
  MFME_COLUMNS.date[0],
  MFME_COLUMNS.content[0],
  MFME_COLUMNS.amount[0],
  MFME_COLUMNS.accountName[0],
  MFME_COLUMNS.categoryMajor[0],
  MFME_COLUMNS.categoryMinor[0],
  MFME_COLUMNS.memo[0],
  MFME_COLUMNS.transferFlag[0],
];

const oneLine = (s: string) => s.replace(/[\t\r\n]+/g, " ");

const isRawRow = (v: unknown): v is RawRow => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    ["date", "content", "amount", "accountName", "categoryMajor", "categoryMinor", "memo"].every(
      (k) => typeof r[k] === "string",
    ) &&
    typeof r.transfer === "boolean" &&
    (r.externalId === null || typeof r.externalId === "string")
  );
};

/**
 * 読んだままの行を `PastedRow` にする。貼り付けと同じ解釈（`parseMfmePaste`）で、読み方を 2 つ持たない。
 * `year` は日付（`MM/DD(曜)`）に補う年。読めない行が 1 つでもあれば `MFME_DOM_CHANGED`（何も加えない）
 */
export function rawRowsToPasted(raw: readonly RawRow[], year: number): PastedRow[] {
  if (raw.length === 0) return [];
  const lines = [
    HEADER.join("\t"),
    ...raw.map((r) =>
      [
        r.date,
        r.content,
        r.amount,
        r.accountName,
        r.categoryMajor,
        r.categoryMinor,
        r.memo,
        r.transfer ? "1" : "0",
      ]
        .map(oneLine)
        .join("\t"),
    ),
  ];
  const parsed = parseMfmePaste(lines.join("\n"), year);
  if (!parsed.ok || parsed.value.unreadable.length > 0 || parsed.value.rows.length !== raw.length) {
    throw domChanged();
  }
  return parsed.value.rows.map((row, i) => {
    const externalId = raw[i]?.externalId;
    return externalId === null || externalId === undefined || externalId === ""
      ? row
      : { ...row, externalId };
  });
}

/**
 * 開いている月の入出金の画面から、表の行を読む。表がなければ `MFME_DOM_CHANGED`。
 * 取引のない月（表はあり、行が 0 件）は空の配列
 */
export async function readCashFlowRows(
  page: MfmeDomPage,
  year: number,
  options: { timeoutMs?: number } = {},
): Promise<PastedRow[]> {
  try {
    await page.waitForSelector(SELECTORS.table, {
      state: "attached",
      timeout: options.timeoutMs ?? 15_000,
    });
  } catch {
    throw domChanged();
  }
  const raw = await page.evaluate(EXTRACT_EXPRESSION);
  if (!Array.isArray(raw) || !raw.every(isRawRow)) throw domChanged();
  return rawRowsToPasted(raw, year);
}
