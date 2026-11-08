import type {
  BillingTermsInput,
  DepreciationMethod,
  InvoiceSettingsInput,
  ReceiptCategory,
  StatementAccountKind,
  StatementAccountUsage,
  StatementColumnMapping,
} from "@trebuchet/schema";
import {
  dateInMonth,
  daysBetween,
  monthAtIndex,
  monthEnd,
  monthOfDate,
  yearOfDate,
} from "../dates.ts";
import type { Honorific, Side } from "../types.ts";

// デモ事業の計画（014 R4・R5、data-model §3、INV-76）。純粋なデータ。科目・補助科目・取引先は名前で指し、ID は持たない
// （`createDemoEntity` が作成後に名前から引く）。取引先名・摘要・金額はすべて架空
// 日付: 作成日 today の月が 3 月以降なら今年、1・2 月なら前の年を会計年度にする。
// 年度の 1 月 1 日〜3 月 1 日の日付は、どの作成日でも作成日以下（3 月以降は今年の 3 月 1 日以前、1・2 月は前の年）。
// それより後の日付は、作成日以下のものだけを計画に入れる

/** 既定の事業体の名前 */
const DEMO_NAME = "デモ事業（サンプル）";

/** 仕訳の 1 行。科目・補助科目・取引先は名前 */
export type DemoLine = {
  side: Side;
  account: string;
  /** 補助科目の名前（`DemoPlan.subAccounts` のどれか） */
  sub?: string | undefined;
  amount: number;
  /** 取引先の名前（`DemoPlan.partners` のどれか） */
  partner?: string | undefined;
  description?: string | undefined;
};

export type DemoOpeningBalance = Pick<DemoLine, "side" | "account" | "sub" | "amount">;

/** 仕訳。`key` は、訂正・取消・資産・証憑が指す名前（計画の中で一意） */
export type DemoJournal = { key: string; date: string; memo: string; lines: DemoLine[] };

/** 仕訳の訂正（日付・摘要・行を置き換える。`key` は訂正する仕訳） */
export type DemoCorrection = {
  key: string;
  date: string;
  memo: string;
  lines: DemoLine[];
  reason: string;
};

export type DemoVoid = { key: string; reason: string };

export type DemoPartner = {
  name: string;
  honorific: Honorific | null;
  /** 請求の条件。なければ請求の対象にしない */
  billingTerms?: BillingTermsInput | undefined;
};

export type DemoFixedAsset = {
  name: string;
  acquiredOn: string;
  acquisitionCost: number;
  method: DepreciationMethod;
  usefulLifeYears?: number | undefined;
  /** 資産の科目の名前 */
  account: string;
  /** 取得の仕訳（`DemoJournal.key`）。結びつけられるのは少額の特例だけ（009） */
  linkedJournalKey?: string | undefined;
};

export type DemoDeferredAsset = {
  name: string;
  totalAmount: number;
  openedOn: string;
  account: string;
};

export type DemoRecurring = {
  name: string;
  dayOfMonth: number;
  /** `YYYY-MM` */
  startMonth: string;
  /** 前の年度のときは年度の 12 月。今年度のときは指定しない */
  endMonth?: string | undefined;
  lines: DemoLine[];
};

export type DemoInvoice = {
  /** 対象月（`YYYY-MM`）。同じ月・取引先の工数がある */
  month: string;
  partner: string;
  issueDate: string;
  /** 入金。なければ未入金。金額は発行した請求書の合計 − 源泉徴収税額、源泉徴収税額は請求書のもの */
  payment?: { receivedOn: string; account: string; sub: string } | undefined;
};

/** 証憑の画像の素材のキー。`DemoAssets.receiptImage` に渡す */
export type DemoReceiptAsset = "receipt-01" | "receipt-05" | "receipt-06";

export type DemoReceipt = {
  asset: DemoReceiptAsset;
  /** 取り込むときのファイル名（拡張子は素材の形式に合わせる） */
  originalName: string;
  category: ReceiptCategory;
  date: string;
  amount: number;
  partnerName: string;
  /** 結びつける仕訳（`DemoJournal.key`） */
  journalKey: string;
};

export type DemoStatement = {
  /** UTF-8 の CSV（日付・摘要・出金額・入金額の 4 列。見出しは 1 行目）。日付は `YYYY/MM/DD` */
  csv: string;
  mapping: StatementColumnMapping;
  /** 取込元の口座名（CSV に口座名の列がないので固定で持つ） */
  fixedAccountName: string;
  account: {
    usage: StatementAccountUsage;
    kind: StatementAccountKind;
    /** 科目・補助科目の名前 */
    account: string;
    sub: string;
  };
  sourceName: string;
};

export type DemoPlan = {
  fiscalYear: number;
  openingBalances: DemoOpeningBalance[];
  subAccounts: { account: string; name: string }[];
  partners: DemoPartner[];
  /** 日付順（登録の順） */
  journals: DemoJournal[];
  corrections: DemoCorrection[];
  voids: DemoVoid[];
  homeUse: { account: string; businessRatio: number; basis: string }[];
  fixedAssets: DemoFixedAsset[];
  deferredAssets: DemoDeferredAsset[];
  recurring: DemoRecurring;
  invoicing: {
    settings: InvoiceSettingsInput;
    workHours: { month: string; partner: string; hours: number }[];
    /** 発行の順 */
    invoices: DemoInvoice[];
  };
  receipts: DemoReceipt[];
  statement: DemoStatement;
};

/**
 * 事業体の名前。既存の名前（アーカイブ済みなどを含む）と重ならない最初の名前:
 * 「デモ事業（サンプル）」、重なれば「デモ事業（サンプル 2）」「…3）」…
 */
export function demoEntityName(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(DEMO_NAME)) return DEMO_NAME;
  for (let n = 2; ; n++) {
    const name = `デモ事業（サンプル ${n}）`;
    if (!taken.has(name)) return name;
  }
}

// ---- 名前（科目・補助科目・取引先） ----

const BANK_A = "サンプル銀行 普通";
const BANK_B = "テスト信用金庫 普通";
const PUBLISHER = "サンプル出版株式会社";
const TRADING = "テスト商事株式会社";
const TELECOM = "デモ通信サービス";

const SALES = "売上高";
const DEPOSIT = "普通預金";
const CASH = "現金";

// ---- 仕訳の部品 ----

const bank = (side: Side, amount: number, partner?: string): DemoLine => ({
  side,
  account: DEPOSIT,
  sub: BANK_A,
  amount,
  partner,
});
const line = (side: Side, account: string, amount: number, partner?: string): DemoLine => ({
  side,
  account,
  amount,
  partner,
});

type Payment = "bank" | "cash";

/** 経費の仕訳（借方 経費、貸方 普通預金か現金） */
function expenseLines(
  account: string,
  amount: number,
  paidBy: Payment,
  partner?: string,
): DemoLine[] {
  return [
    line("debit", account, amount, partner),
    paidBy === "bank" ? bank("credit", amount) : line("credit", CASH, amount),
  ];
}

type FillerSpec = {
  month: number;
  day: number;
  memo: string;
  account: string;
  amount: number;
  paidBy: Payment;
  partner?: string;
};

/**
 * 日付が作成日以下のものだけを計画に入れる経費・事業主勘定の仕訳（1〜2 月の分は、どの作成日でも入る）。
 * 仕訳に結びつけるもの（資産・証憑・訂正・取消）は `specialJournals` に別に持つ
 */
const FILLERS: readonly FillerSpec[] = [
  { month: 1, day: 18, memo: "文房具", account: "消耗品費", amount: 3_278, paidBy: "cash" },
  {
    month: 2,
    day: 5,
    memo: "インターネット回線 1月分",
    account: "通信費",
    amount: 6_600,
    paidBy: "bank",
    partner: TELECOM,
  },
  { month: 2, day: 20, memo: "ATM 引き出し", account: CASH, amount: 30_000, paidBy: "bank" },
  {
    month: 3,
    day: 20,
    memo: "打合せの交通費",
    account: "旅費交通費",
    amount: 2_340,
    paidBy: "cash",
  },
  { month: 4, day: 14, memo: "打合せ 喫茶代", account: "会議費", amount: 1_650, paidBy: "cash" },
  { month: 4, day: 30, memo: "振込手数料", account: "支払手数料", amount: 440, paidBy: "bank" },
  {
    month: 5,
    day: 6,
    memo: "インターネット回線 4月分",
    account: "通信費",
    amount: 6_820,
    paidBy: "bank",
    partner: TELECOM,
  },
  { month: 5, day: 12, memo: "電気料金", account: "水道光熱費", amount: 7_900, paidBy: "bank" },
  { month: 5, day: 28, memo: "出張 新幹線", account: "旅費交通費", amount: 28_400, paidBy: "bank" },
  { month: 6, day: 14, memo: "コピー用紙", account: "消耗品費", amount: 4_580, paidBy: "bank" },
  { month: 8, day: 12, memo: "電気料金", account: "水道光熱費", amount: 11_200, paidBy: "bank" },
  {
    month: 8,
    day: 20,
    memo: "Web サイトの更新費用",
    account: "広告宣伝費",
    amount: 12_000,
    paidBy: "bank",
  },
  {
    month: 9,
    day: 3,
    memo: "プリンターインク",
    account: "消耗品費",
    amount: 7_260,
    paidBy: "bank",
  },
  { month: 9, day: 25, memo: "打合せ 喫茶代", account: "会議費", amount: 2_750, paidBy: "cash" },
  {
    month: 10,
    day: 8,
    memo: "打合せの交通費",
    account: "旅費交通費",
    amount: 1_860,
    paidBy: "cash",
  },
  { month: 10, day: 12, memo: "電気料金", account: "水道光熱費", amount: 6_300, paidBy: "bank" },
  { month: 11, day: 5, memo: "打合せ 喫茶代", account: "会議費", amount: 1_980, paidBy: "cash" },
  { month: 12, day: 5, memo: "電気料金", account: "水道光熱費", amount: 9_100, paidBy: "bank" },
];

/** 生活費（事業主貸）と私用の口座からの入金（事業主借）。日付が作成日以下のものだけ入る */
const OWNER: readonly {
  month: number;
  day: number;
  memo: string;
  account: string;
  side: Side;
  amount: number;
}[] = [
  { month: 3, day: 31, memo: "生活費", account: "事業主貸", side: "debit", amount: 100_000 },
  {
    month: 5,
    day: 2,
    memo: "私用の口座から入金",
    account: "事業主借",
    side: "credit",
    amount: 50_000,
  },
  { month: 6, day: 30, memo: "生活費", account: "事業主貸", side: "debit", amount: 100_000 },
  { month: 9, day: 30, memo: "生活費", account: "事業主貸", side: "debit", amount: 120_000 },
  { month: 12, day: 28, memo: "生活費", account: "事業主貸", side: "debit", amount: 100_000 },
];

/** 売上（請求書にしない月の分。月末に普通預金へ入金）。月ごとの金額 */
const SALES_AMOUNTS = [
  220_000, 220_000, 235_000, 240_000, 210_000, 250_000, 260_000, 230_000, 245_000, 255_000,
];

// ---- 計画 ----

/**
 * デモ事業の計画を作る（作成日 `today`: `YYYY-MM-DD`）。純関数。
 * 年度は、作成日の月が 3 月以上なら作成日の年、1・2 月なら前の年（US3）。作成日より後の日付は入れない（INV-76）
 */
export function buildDemoPlan(today: string): DemoPlan {
  const month = Number(monthOfDate(today).slice(5));
  const previousYear = month < 3;
  const fiscalYear = previousYear ? yearOfDate(today) - 1 : yearOfDate(today);

  /** 年度の m 月（1〜12）の `YYYY-MM` */
  const ym = (m: number): string => monthAtIndex(fiscalYear * 12 + m - 1);
  const dateOf = (m: number, day: number): string => dateInMonth(ym(m), day);
  const upToToday = (date: string): boolean => daysBetween(date, today) >= 0;

  // 請求書にする月（b の月の工数 → b+1 月に発行・月末に入金、b+1 月の工数 → b+2 月 1 日に発行・未入金）。
  // 作成日の直近になるよう、今年度は発行日が作成日以下になる最も遅い月（1〜10）。前の年度は 10 月
  const base = previousYear ? 10 : Math.min(10, month - 2);

  const journals: DemoJournal[] = [];
  const add = (key: string, date: string, memo: string, lines: DemoLine[]): void => {
    journals.push({ key, date, memo, lines });
  };

  // 売上（請求書にしない月）
  for (let m = 1; m < base; m++) {
    const amount = SALES_AMOUNTS[m - 1] ?? 200_000;
    add(`sales-${m}`, monthEnd(ym(m)), `${m}月分 業務委託料`, [
      bank("debit", amount, TRADING),
      line("credit", SALES, amount),
    ]);
  }
  // 経費・事業主勘定（作成日以下のものだけ）
  FILLERS.forEach((f, i) => {
    const date = dateOf(f.month, f.day);
    if (!upToToday(date)) return;
    add(`expense-${i}`, date, f.memo, expenseLines(f.account, f.amount, f.paidBy, f.partner));
  });
  OWNER.forEach((o, i) => {
    const date = dateOf(o.month, o.day);
    if (!upToToday(date)) return;
    const amount = o.amount;
    add(`owner-${i}`, date, o.memo, [
      o.side === "debit" ? line("debit", o.account, amount) : bank("debit", amount),
      o.side === "debit" ? bank("credit", amount) : line("credit", o.account, amount),
    ]);
  });

  // 仕訳に結びつくもの（資産・証憑・訂正・取消）。1〜2 月の日付で、どの作成日でも入る
  add("startup", dateOf(1, 20), "開業準備費用（名刺・Web サイトの初期費用）", [
    line("debit", "開業費", 180_000),
    bank("credit", 180_000),
  ]);
  add("laptop", dateOf(1, 28), "ノート PC の購入", [
    line("debit", "工具器具備品", 240_000),
    bank("credit", 240_000),
  ]);
  add("commute", dateOf(2, 8), "打合せの交通費", expenseLines("旅費交通費", 1_860, "cash"));
  add("duplicate", dateOf(2, 8), "打合せの交通費", expenseLines("旅費交通費", 1_860, "cash"));
  add("monitor", dateOf(2, 10), "外付けモニターの購入", [
    line("debit", "工具器具備品", 98_000),
    bank("credit", 98_000),
  ]);
  add("electricity", dateOf(2, 12), "電気料金", expenseLines("水道光熱費", 8_400, "bank"));
  add("printer", dateOf(2, 15), "業務用プリンターの購入", [
    line("debit", "一括償却資産", 150_000),
    bank("credit", 150_000),
  ]);
  add("stationery", dateOf(2, 20), "文房具（合成商店）", expenseLines("消耗品費", 1_100, "cash"));
  add(
    "taxi",
    dateOf(2, 24),
    "タクシー代（架空タクシー）",
    expenseLines("旅費交通費", 2_350, "cash"),
  );
  add(
    "coffee",
    dateOf(2, 25),
    "打合せ 喫茶代（合成コーヒー）",
    expenseLines("会議費", 1_540, "cash"),
  );
  // 登録の順を日付順にする（同じ日は入れた順）
  journals.sort((a, b) => daysBetween(b.date, a.date));

  const issueOf = (m: number): string => dateOf(m, 1);

  return {
    fiscalYear,
    openingBalances: [
      { side: "debit", account: CASH, amount: 100_000 },
      { side: "debit", account: DEPOSIT, sub: BANK_A, amount: 1_800_000 },
      { side: "debit", account: DEPOSIT, sub: BANK_B, amount: 400_000 },
      { side: "credit", account: "元入金", amount: 2_300_000 },
    ],
    subAccounts: [
      { account: DEPOSIT, name: BANK_A },
      { account: DEPOSIT, name: BANK_B },
    ],
    partners: [
      {
        name: PUBLISHER,
        honorific: "御中",
        billingTerms: {
          billingType: "hourly",
          unitPrice: 5_000,
          priceMode: "exclusive",
          taxRate: 10,
          dueMonthsAfter: 1,
          dueDay: 31,
          defaultItemName: "デザイン制作",
          withholding: true,
        },
      },
      {
        name: TRADING,
        honorific: "御中",
        billingTerms: {
          billingType: "hourly",
          unitPrice: 6_000,
          priceMode: "exclusive",
          taxRate: 10,
          dueMonthsAfter: 1,
          dueDay: 31,
          defaultItemName: "システム開発",
          withholding: false,
        },
      },
      { name: TELECOM, honorific: null },
    ],
    journals,
    corrections: [
      {
        key: "electricity",
        date: dateOf(2, 12),
        memo: "電気料金",
        lines: expenseLines("水道光熱費", 8_460, "bank"),
        reason: "請求書の金額に訂正",
      },
    ],
    voids: [{ key: "duplicate", reason: "二重に登録したため取消" }],
    homeUse: [
      {
        account: "地代家賃",
        businessRatio: 5_000,
        basis: "自宅兼事務所。事務所に使う床面積の割合 50%（架空）",
      },
      {
        account: "水道光熱費",
        businessRatio: 3_000,
        basis: "事務所に使う面積・使用時間から 30%（架空）",
      },
      { account: "通信費", businessRatio: 7_000, basis: "業務に使う通信の割合 70%（架空）" },
    ],
    fixedAssets: [
      {
        name: "ノート PC",
        acquiredOn: dateOf(1, 28),
        acquisitionCost: 240_000,
        method: "straight_line",
        usefulLifeYears: 4,
        account: "工具器具備品",
      },
      {
        name: "外付けモニター",
        acquiredOn: dateOf(2, 10),
        acquisitionCost: 98_000,
        method: "small_asset_28_2",
        account: "工具器具備品",
        linkedJournalKey: "monitor",
      },
      {
        name: "業務用プリンター",
        acquiredOn: dateOf(2, 15),
        acquisitionCost: 150_000,
        method: "lump_sum",
        account: "一括償却資産",
      },
    ],
    deferredAssets: [
      { name: "開業準備費用", totalAmount: 180_000, openedOn: dateOf(1, 15), account: "開業費" },
    ],
    recurring: {
      name: "事務所家賃",
      dayOfMonth: 25,
      startMonth: ym(1),
      endMonth: previousYear ? ym(12) : undefined,
      lines: [
        { ...line("debit", "地代家賃", 80_000), description: "事務所家賃" },
        bank("credit", 80_000),
      ],
    },
    invoicing: {
      settings: {
        issuerName: "デモ 太郎",
        address: "東京都千代田区サンプル 1-2-3（架空）",
        contact: "03-0000-0000",
        bankAccount: "サンプル銀行 本店 普通 0000000 デモ タロウ",
        taxDisplay: "separate",
        nextSeq: 1,
      },
      workHours: [
        { month: ym(base), partner: PUBLISHER, hours: 40 },
        { month: ym(base + 1), partner: TRADING, hours: 30 },
      ],
      invoices: [
        {
          month: ym(base),
          partner: PUBLISHER,
          issueDate: issueOf(base + 1),
          payment: { receivedOn: monthEnd(ym(base + 1)), account: DEPOSIT, sub: BANK_A },
        },
        { month: ym(base + 1), partner: TRADING, issueDate: issueOf(base + 2) },
      ],
    },
    receipts: [
      {
        asset: "receipt-01",
        originalName: "receipt-01.jpg",
        category: "paper_scan",
        date: dateOf(2, 20),
        amount: 1_100,
        partnerName: "合成商店",
        journalKey: "stationery",
      },
      {
        asset: "receipt-05",
        originalName: "receipt-05.jpg",
        category: "paper_scan",
        date: dateOf(2, 24),
        amount: 2_350,
        partnerName: "架空タクシー",
        journalKey: "taxi",
      },
      {
        asset: "receipt-06",
        originalName: "receipt-06.png",
        category: "paper_scan",
        date: dateOf(2, 25),
        amount: 1_540,
        partnerName: "合成コーヒー",
        journalKey: "coffee",
      },
    ],
    statement: statementOf(dateOf),
  };
}

// ---- 明細 ----

/** 銀行の明細（1・2 月の 10 件。いくつかは登録済みの仕訳と日付・金額が同じ） */
const STATEMENT_ROWS: readonly {
  month: number;
  day: number;
  content: string;
  out: number;
  inn: number;
}[] = [
  { month: 1, day: 6, content: "カード引落 テストカードA", out: 45_000, inn: 0 },
  { month: 1, day: 15, content: "フリコミ テストショウジ", out: 0, inn: 220_000 },
  { month: 1, day: 25, content: "家賃 サンプル不動産", out: 80_000, inn: 0 },
  { month: 1, day: 31, content: "口座維持手数料", out: 1_100, inn: 0 },
  { month: 2, day: 3, content: "振込手数料", out: 330, inn: 0 },
  { month: 2, day: 5, content: "インターネット デモツウシン", out: 6_600, inn: 0 },
  { month: 2, day: 14, content: "利息", out: 0, inn: 12 },
  { month: 2, day: 20, content: "ATM 引出", out: 30_000, inn: 0 },
  { month: 2, day: 25, content: "家賃 サンプル不動産", out: 80_000, inn: 0 },
  { month: 2, day: 27, content: "フリコミ テストショウジ", out: 0, inn: 235_000 },
];

function statementOf(dateOf: (month: number, day: number) => string): DemoStatement {
  const quote = (s: string | number): string => `"${s}"`;
  const rows = STATEMENT_ROWS.map((r) =>
    [
      quote(dateOf(r.month, r.day).replaceAll("-", "/")),
      quote(r.content),
      quote(r.out === 0 ? "" : r.out),
      quote(r.inn === 0 ? "" : r.inn),
    ].join(","),
  );
  return {
    csv: `${[['"取引日"', '"摘要"', '"出金額"', '"入金額"'].join(","), ...rows].join("\n")}\n`,
    mapping: {
      delimiter: ",",
      headerRow: 0,
      columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
    },
    fixedAccountName: "サンプル銀行",
    account: { usage: "business", kind: "bank", account: DEPOSIT, sub: BANK_A },
    sourceName: "サンプル銀行 入出金明細",
  };
}
