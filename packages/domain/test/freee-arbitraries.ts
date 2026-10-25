import fc from "fast-check";
import type { Side } from "../src/types.ts";
import { dateInPeriodArb, makeFiscalPeriod } from "./arbitraries.ts";
import { FREEE_JOURNAL_HEADER, FREEE_LEDGER_HEADER } from "./fixtures/freee/headers.ts";

/**
 * freee の書き出し（仕訳帳・総勘定元帳）を生成する fast-check のジェネレーター（research R17, INV-14, INV-16）。
 * 001 の arbitraries.ts と同じく、まずモデル（科目・期首・仕訳）を生成し、そこから CSV を作る。
 * 元帳の残高はモデルの仕訳から計算するので、仕訳帳と元帳は常に整合する。
 * 書式はフィクスチャ（fixtures/freee/README.md）と同じ: 全項目クォート、LF、仕訳帳の日付は YYYY/MM/DD、
 * 元帳は1行目がタイトル・2行目がヘッダ、日付は YYYY-MM-DD、開始行は「前期繰越」、相手が複数なら「諸口」
 */

type FreeeAccountKind = "asset" | "liability" | "equity" | "revenue" | "expense" | "closing";

type FreeeAccountDef = {
  /** freee の勘定科目名（ファイルの表記のまま。全角を含むことがある） */
  name: string;
  kind: FreeeAccountKind;
  /** freee の元帳で残高が正になる側 */
  normalSide: Side;
  /** 仕訳帳の補助科目名（口座・カードは科目名と同じ） */
  subAccountName?: string | undefined;
  /** 帳簿の科目（seed のコード）と補助科目名（NFKC 後）。research R13 の初期案。「損益」は null */
  book: { code: string; subAccountName?: string | undefined } | null;
};

type FreeeLegModel = {
  account: string;
  amount: number;
  taxName: string;
  taxAmount: number;
  partnerName?: string | undefined;
  tagName?: string | undefined;
  remarks?: string | undefined;
};

/** freee の仕訳帳の1行。借方と貸方の両方、またはどちらか一方を持つ */
type FreeeRowModel = {
  debit?: FreeeLegModel | undefined;
  credit?: FreeeLegModel | undefined;
  description: string;
};

export type FreeeJournalModel = {
  id: string;
  journalNo: string;
  /** YYYY-MM-DD */
  date: string;
  adjustment: 0 | 1;
  method: "自動で経理" | "決算" | "手動" | "減価償却";
  rows: FreeeRowModel[];
};

export type FreeeModel = {
  fiscalYear: number;
  /** 元帳の科目の並び（資産 → 負債 → 純資産 → 損益 → 収益 → 費用） */
  accounts: FreeeAccountDef[];
  /** 元帳の開始行（前期繰越）の残高。年初付の決算振替の **前** の値で、通常残高の側が正。0 の科目は開始行を持たない */
  opening: Record<string, number>;
  /** 前年の利益（損益 → 元入金の振替の額。1以上） */
  priorYearProfit: number;
  /** 期首日付の前年分の決算振替（3行。事業主借→元入金、損益→元入金、元入金→事業主貸） */
  closing: FreeeJournalModel;
  /** 当年の取引（決算振替を除く）。日付の順 */
  journals: FreeeJournalModel[];
};

export const OPENING_ROW_COUNTERPART = "前期繰越";
const MIXED_COUNTERPART = "諸口";

const acc = (
  name: string,
  kind: FreeeAccountKind,
  book: FreeeAccountDef["book"],
  subAccountName?: string,
): FreeeAccountDef => ({
  name,
  kind,
  normalSide: kind === "asset" || kind === "expense" ? "debit" : "credit",
  subAccountName,
  book,
});

const BANK = acc("その他口座", "asset", { code: "1020" }, "その他口座");
const RECEIVABLE = acc("売掛金", "asset", { code: "1030" });
const DRAWINGS = { ...acc("事業主貸", "equity", { code: "3090" }), normalSide: "debit" as const };
const OWNER_LOAN = acc("事業主借", "equity", { code: "3010" });
const CAPITAL = acc("元入金", "equity", { code: "3020" });
const PROFIT_AND_LOSS = acc("損益", "closing", null);
const SALES = acc("売上高", "revenue", { code: "4010" });

const OPTIONAL_ASSETS = [
  acc("現金", "asset", { code: "1010" }),
  acc("工具器具備品", "asset", { code: "1060" }),
];
const OPTIONAL_LIABILITIES = [acc("未払金", "liability", { code: "2020" })];
const OPTIONAL_REVENUES = [acc("雑収入", "revenue", { code: "4020" })];
const EXPENSES = [
  acc("交際費", "expense", { code: "5140" }),
  acc("事務用品費", "expense", { code: "5170" }),
  acc("消耗品費", "expense", { code: "5170" }),
  acc("通信費", "expense", { code: "5120" }),
  acc("旅費交通費", "expense", { code: "5110" }),
  acc("支払手数料", "expense", { code: "5250" }),
  acc("減価償却費", "expense", { code: "5180" }),
];
/** カードの科目名。NFKC 後に互いに重ならない */
const CARD_NAMES = ["ＡＢＣカード", "XYZカード", "テスト　カード"];
const card = (name: string): FreeeAccountDef =>
  acc(name, "liability", { code: "2020", subAccountName: name.normalize("NFKC").trim() }, name);

const TAX_NAMES: Record<FreeeAccountKind, string[]> = {
  asset: ["対象外"],
  liability: ["対象外"],
  equity: ["対象外"],
  closing: ["対象外"],
  revenue: ["課税売上10%", "課税売上8%（軽）", "対象外"],
  expense: ["課対仕入10%", "課対仕入8%（軽）", "対象外"],
};
const PARTNERS = ["株式会社サンプル", "㈱テスト飯店", "サンプル　商店"];
const TAGS = ["案件Ａ", "案件B", "ＰＪ　１"];
const DESCRIPTION_UNITS = ["業務", "委託", "料", "ＵＳＢ", "Ａ４", "　", " ", "ュ", "１", "ｶ", "-"];

/** 内税・切り捨ての税額（001 の INV-10 と同じ計算） */
function freeeTaxAmount(taxName: string, amount: number): number {
  const rate = taxName.endsWith("10%") ? 10 : taxName.endsWith("8%（軽）") ? 8 : 0;
  return Math.floor((amount * rate) / (100 + rate));
}

/** 科目の集合: 必須の科目（口座・売掛金・事業主勘定・元入金・損益・売上高）、カード1〜2、費用1つ以上 */
const freeeAccountsArb: fc.Arbitrary<FreeeAccountDef[]> = fc
  .record({
    assets: fc.subarray(OPTIONAL_ASSETS),
    liabilities: fc.subarray(OPTIONAL_LIABILITIES),
    cards: fc.subarray(CARD_NAMES, { minLength: 1, maxLength: 2 }),
    revenues: fc.subarray(OPTIONAL_REVENUES),
    expenses: fc.subarray(EXPENSES, { minLength: 1 }),
  })
  .map(({ assets, liabilities, cards, revenues, expenses }) => [
    BANK,
    RECEIVABLE,
    ...assets,
    DRAWINGS,
    ...liabilities,
    ...cards.map(card),
    OWNER_LOAN,
    CAPITAL,
    PROFIT_AND_LOSS,
    SALES,
    ...revenues,
    ...expenses,
  ]);

const balanceArb = fc.integer({ min: 0, max: 5_000_000 });
const positiveArb = fc.integer({ min: 1, max: 5_000_000 });

type OpeningPart = Pick<FreeeModel, "opening" | "priorYearProfit">;

/**
 * 振替前の前期繰越と前年の利益。research R5 の関係（資産 ＋ 事業主貸 = 負債 ＋ 事業主借 ＋ 元入金 ＋ 利益）を満たす。
 * 売掛金はマイナスになりうる。元入金は振替の前・後とも 1 以上（足りなければ口座の残高を増やす）
 */
function openingArb(accounts: readonly FreeeAccountDef[]): fc.Arbitrary<OpeningPart> {
  const free = accounts.filter((a) => a.kind === "asset" || a.kind === "liability");
  return fc
    .record({
      balances: fc.tuple(
        ...free.map((a) =>
          a === RECEIVABLE ? fc.integer({ min: -1_000_000, max: 5_000_000 }) : balanceArb,
        ),
      ),
      drawings: positiveArb,
      ownerLoan: positiveArb,
      profit: positiveArb,
    })
    .map(({ balances, drawings, ownerLoan, profit }) => {
      const opening: Record<string, number> = {};
      free.forEach((a, i) => {
        opening[a.name] = balances[i] ?? 0;
      });
      opening[DRAWINGS.name] = drawings;
      opening[OWNER_LOAN.name] = ownerLoan;
      const sum = (kind: FreeeAccountKind) =>
        free.filter((a) => a.kind === kind).reduce((s, a) => s + (opening[a.name] ?? 0), 0);
      // 振替後の元入金（= 資産 − 負債）と振替前の元入金が、どちらも 1 以上になるよう口座の残高を増やす
      const netAssets = sum("asset") - sum("liability");
      const shortage = Math.max(0, 1 - netAssets, 1 - (netAssets + drawings - ownerLoan - profit));
      opening[BANK.name] = (opening[BANK.name] ?? 0) + shortage;
      opening[CAPITAL.name] = netAssets + shortage + drawings - ownerLoan - profit;
      return { opening, priorYearProfit: profit };
    });
}

/** 合計が total になる正の整数の分割（count 個。total >= count） */
function splitArb(total: number, count: number): fc.Arbitrary<number[]> {
  if (count === 1) return fc.constant([total]);
  return fc
    .uniqueArray(fc.integer({ min: 1, max: total - 1 }), {
      minLength: count - 1,
      maxLength: count - 1,
    })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), total];
      return points.slice(1).map((p, i) => p - (points[i] ?? 0));
    });
}

function legArb(accounts: readonly FreeeAccountDef[], amount: number): fc.Arbitrary<FreeeLegModel> {
  return fc.constantFrom(...accounts).chain((a) =>
    fc
      .record({
        taxName: fc.constantFrom(...TAX_NAMES[a.kind]),
        partnerName: fc.option(fc.constantFrom(...PARTNERS), { nil: undefined }),
        tagName: fc.option(fc.constantFrom(...TAGS), { nil: undefined }),
        remarks: fc.option(fc.constantFrom("源泉所得税", "按分なし", "立替　分"), {
          nil: undefined,
        }),
      })
      .map(({ taxName, ...rest }) => ({
        account: a.name,
        amount,
        taxName,
        taxAmount: freeeTaxAmount(taxName, amount),
        ...rest,
      })),
  );
}

type JournalDraftModel = Omit<FreeeJournalModel, "id" | "journalNo">;

/**
 * 貸借が一致する仕訳（借方・貸方とも1〜4脚）。i 番目の行に i 番目の借方と貸方を置くので、
 * 脚の数が違えば片側が空の行ができる
 */
function journalArb(
  accounts: readonly FreeeAccountDef[],
  fiscalYear: number,
): fc.Arbitrary<JournalDraftModel> {
  const usable = accounts.filter((a) => a.kind !== "closing");
  const startDate = `${fiscalYear}-01-01`;
  return fc
    .record({
      date: dateInPeriodArb(makeFiscalPeriod(fiscalYear)),
      debitCount: fc.integer({ min: 1, max: 4 }),
      creditCount: fc.integer({ min: 1, max: 4 }),
      total: fc.integer({ min: 4, max: 3_000_000 }),
      method: fc.constantFrom("自動で経理" as const, "手動" as const, "減価償却" as const),
    })
    .chain(({ debitCount, creditCount, total, ...head }) =>
      fc
        .tuple(splitArb(total, debitCount), splitArb(total, creditCount))
        .chain(([debits, credits]) =>
          fc.tuple(
            fc.tuple(...debits.map((amount) => legArb(usable, amount))),
            fc.tuple(...credits.map((amount) => legArb(usable, amount))),
            fc.array(fc.string({ unit: fc.constantFrom(...DESCRIPTION_UNITS), maxLength: 6 }), {
              minLength: Math.max(debitCount, creditCount),
              maxLength: Math.max(debitCount, creditCount),
            }),
          ),
        )
        .map(([debitLegs, creditLegs, descriptions]) => ({
          ...head,
          // 減価償却は決算整理仕訳。ただし期首日付の決算整理仕訳は前年分の決算振替と判定されるので作らない
          adjustment: head.method === "減価償却" && head.date !== startDate ? 1 : 0,
          rows: descriptions.map((description, i) => ({
            debit: debitLegs[i],
            credit: creditLegs[i],
            description,
          })),
        })),
    );
}

function closingJournal(part: OpeningPart, fiscalYear: number): JournalDraftModel {
  const leg = (account: string, amount: number): FreeeLegModel => ({
    account,
    amount,
    taxName: "対象外",
    taxAmount: 0,
  });
  const ownerLoan = part.opening[OWNER_LOAN.name] ?? 0;
  const drawings = part.opening[DRAWINGS.name] ?? 0;
  return {
    date: `${fiscalYear}-01-01`,
    adjustment: 1,
    method: "決算",
    rows: [
      {
        debit: leg(OWNER_LOAN.name, ownerLoan),
        credit: leg(CAPITAL.name, ownerLoan),
        description: "",
      },
      {
        debit: leg(PROFIT_AND_LOSS.name, part.priorYearProfit),
        credit: leg(CAPITAL.name, part.priorYearProfit),
        description: "",
      },
      { debit: leg(CAPITAL.name, drawings), credit: leg(DRAWINGS.name, drawings), description: "" },
    ],
  };
}

/** 仕訳ID は生成の順の連番、仕訳番号は「年の下1桁 ＋ 月日 ＋ その日の連番」（合成の規則） */
function numberJournals(drafts: JournalDraftModel[]): FreeeJournalModel[] {
  const sorted = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.date.localeCompare(b.d.date) || a.i - b.i);
  const perDay = new Map<string, number>();
  return sorted.map(({ d }, i) => {
    const n = (perDay.get(d.date) ?? 0) + 1;
    perDay.set(d.date, n);
    const [y, m, day] = d.date.split("-") as [string, string, string];
    return {
      ...d,
      id: String(100_000_001 + i),
      journalNo: `${y.slice(-1)}${m}${day}${String(n).padStart(3, "0")}`,
    };
  });
}

/** freee の科目・期首・決算振替・当年の仕訳のモデル */
export function freeeModelArb(
  options: { fiscalYear?: number; maxJournals?: number } = {},
): fc.Arbitrary<FreeeModel> {
  const fiscalYear = options.fiscalYear ?? 2025;
  return freeeAccountsArb.chain((accounts) =>
    fc
      .tuple(
        openingArb(accounts),
        fc.array(journalArb(accounts, fiscalYear), { maxLength: options.maxJournals ?? 20 }),
      )
      .map(([part, drafts]) => {
        const [closing, ...journals] = numberJournals([
          closingJournal(part, fiscalYear),
          ...drafts,
        ]);
        return { fiscalYear, accounts, ...part, closing: closing as FreeeJournalModel, journals };
      }),
  );
}

// ---- モデルから計算する値 ----

const legsOf = (j: FreeeJournalModel) =>
  j.rows.flatMap((r) => [
    ...(r.debit ? [{ side: "debit" as Side, leg: r.debit, description: r.description }] : []),
    ...(r.credit ? [{ side: "credit" as Side, leg: r.credit, description: r.description }] : []),
  ]);

const signed = (account: FreeeAccountDef, side: Side, amount: number) =>
  side === account.normalSide ? amount : -amount;

/** 決算振替と当年の仕訳を、元帳と同じ順（日付 → 仕訳番号）に並べたもの */
const allFreeeJournals = (model: FreeeModel): FreeeJournalModel[] =>
  [model.closing, ...model.journals].sort(
    (a, b) => a.date.localeCompare(b.date) || a.journalNo.localeCompare(b.journalNo),
  );

export type FreeeLedgerTotals = {
  /** 開始行の残高（振替前） */
  opening: number;
  /** 決算振替を繰り込んだ期首（research R7） */
  openingAfterClosing: number;
  /** 決算振替を除く借方・貸方の合計 */
  debit: number;
  credit: number;
  closing: number;
};

/** freee の科目ごとの元帳の値（通常残高の側が正）。元帳に行がない科目も含む */
export function freeeLedgerTotals(model: FreeeModel): Map<string, FreeeLedgerTotals> {
  const totals = new Map<string, FreeeLedgerTotals>();
  for (const a of model.accounts) {
    const opening = model.opening[a.name] ?? 0;
    totals.set(a.name, {
      opening,
      openingAfterClosing: opening,
      debit: 0,
      credit: 0,
      closing: opening,
    });
  }
  for (const j of allFreeeJournals(model)) {
    for (const { side, leg } of legsOf(j)) {
      const account = model.accounts.find((a) => a.name === leg.account);
      const t = totals.get(leg.account);
      if (!account || !t) throw new Error(`科目がない: ${leg.account}`);
      const delta = signed(account, side, leg.amount);
      t.closing += delta;
      if (j === model.closing) t.openingAfterClosing += delta;
      else if (side === "debit") t.debit += leg.amount;
      else t.credit += leg.amount;
    }
  }
  return totals;
}

export type BookOpeningBalance = {
  code: string;
  subAccountName?: string | undefined;
  /** 帳簿の科目の通常残高の側が正 */
  balance: number;
};

/**
 * 振替後の期首を帳簿の科目（seed のコード）・補助科目ごとに合算したもの（損益を除き、0 も含む）。
 * 対応先の帳簿の科目の通常残高の側は、freee の科目と同じ（カード → 未払金、口座 → 普通預金）
 */
export function bookOpeningBalances(model: FreeeModel): BookOpeningBalance[] {
  const totals = freeeLedgerTotals(model);
  const byKey = new Map<string, BookOpeningBalance>();
  for (const a of model.accounts) {
    if (a.book === null) continue;
    const key = `${a.book.code}\u0000${a.book.subAccountName ?? ""}`;
    const row = byKey.get(key) ?? { ...a.book, balance: 0 };
    row.balance += totals.get(a.name)?.openingAfterClosing ?? 0;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

// ---- CSV ----

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const csvLine = (cells: readonly string[]) => `${cells.map(quote).join(",")}\n`;
const encode = (text: string) => new TextEncoder().encode(text);

/** freee の仕訳帳（103列、UTF-8、全項目クォート、LF）。決算振替を含め、日付の順に並べる */
export function toFreeeJournalCsv(model: FreeeModel): Uint8Array {
  const accounts = new Map(model.accounts.map((a) => [a.name, a]));
  let text = csvLine(FREEE_JOURNAL_HEADER);
  let record = 0;
  allFreeeJournals(model).forEach((j, i) => {
    j.rows.forEach((row, k) => {
      record += 1;
      const cells: Record<string, string> = {
        No: String(i + 1),
        取引日: j.date.replaceAll("-", "/"),
        決算整理仕訳: String(j.adjustment),
        仕訳ID: j.id,
        仕訳番号: j.journalNo,
        仕訳行番号: String(k + 1),
        仕訳行数: String(j.rows.length),
        レコード番号: String(record),
        取引内容: row.description,
        登録した方法: j.method,
      };
      for (const [prefix, leg] of [
        ["借方", row.debit],
        ["貸方", row.credit],
      ] as const) {
        if (!leg) continue;
        cells[`${prefix}勘定科目`] = leg.account;
        cells[`${prefix}補助科目名`] = accounts.get(leg.account)?.subAccountName ?? "";
        cells[`${prefix}金額`] = String(leg.amount);
        cells[`${prefix}税区分`] = leg.taxName;
        cells[`${prefix}税金額`] = String(leg.taxAmount);
        cells[`${prefix}取引先名`] = leg.partnerName ?? "";
        cells[`${prefix}メモ`] = leg.tagName ?? "";
        cells[`${prefix}備考`] = leg.remarks ?? "";
      }
      text += csvLine(FREEE_JOURNAL_HEADER.map((h) => cells[h] ?? ""));
    });
  });
  return encode(text);
}

/**
 * freee の総勘定元帳（24列、UTF-8、1行目がタイトル、全項目クォート、LF）。
 * 実ファイルは CP932 だが、文字コードの分岐は fixtures/freee/ledger-2025.csv で検証する。
 * 科目ごとに、開始行（振替前の残高が 0 でなければ）→ 決算振替と当年の仕訳の脚（日付の順）。残高は仕訳から積み上げる
 */
export function toFreeeLedgerCsv(model: FreeeModel): Uint8Array {
  const y = model.fiscalYear;
  let text = csvLine([`総勘定元帳 (${y}年01月~${y}年12月）`]) + csvLine(FREEE_LEDGER_HEADER);
  const journals = allFreeeJournals(model);
  for (const account of model.accounts) {
    let balance = model.opening[account.name] ?? 0;
    if (balance !== 0) {
      const cells: Record<string, string> = {
        勘定科目: account.name,
        取引日: `${y}-01-01`,
        決算整理仕訳: "0",
        相手勘定科目: OPENING_ROW_COUNTERPART,
        残高: String(balance),
      };
      text += csvLine(FREEE_LEDGER_HEADER.map((h) => cells[h] ?? ""));
    }
    for (const j of journals) {
      const legs = legsOf(j);
      for (const { side, leg, description } of legs) {
        if (leg.account !== account.name) continue;
        const opposite = legs.filter((l) => l.side !== side);
        const single = opposite.length === 1 ? opposite[0]?.leg : undefined;
        balance += signed(account, side, leg.amount);
        const cells: Record<string, string> = {
          勘定科目: account.name,
          取引日: j.date,
          決算整理仕訳: String(j.adjustment),
          相手勘定科目: single ? single.account : MIXED_COUNTERPART,
          税区分: leg.taxName,
          仕訳番号: j.journalNo,
          取引先: leg.partnerName ?? "",
          メモタグ: leg.tagName ?? "",
          備考: leg.remarks ?? "",
          相手取引先: single?.partnerName ?? "",
          相手メモタグ: single?.tagName ?? "",
          相手備考: single?.remarks ?? "",
          取引内容: description,
          借方金額: side === "debit" ? String(leg.amount) : "",
          貸方金額: side === "credit" ? String(leg.amount) : "",
          残高: String(balance),
        };
        text += csvLine(FREEE_LEDGER_HEADER.map((h) => cells[h] ?? ""));
      }
    }
  }
  return encode(text);
}
