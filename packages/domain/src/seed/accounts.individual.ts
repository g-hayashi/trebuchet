import type { Account, AccountCategory, ReportSection, Side } from "../types.ts";

/** 初期セットの科目（ID と状態は事業体の作成時に付ける） */
export type SeedAccount = Omit<Account, "id" | "isSystem" | "isActive">;

/** 決算書の区分の並び（BS → PL）と、区分ごとの sort_order の起点 */
export const SECTION_SORT_BASE: Record<ReportSection, number> = {
  BS_ASSET: 1000,
  BS_LIABILITY: 2000,
  BS_EQUITY: 3000,
  PL_SALES: 4000,
  PL_COGS: 5000,
  PL_EXPENSE: 6000,
  PL_OTHER: 7000,
};

export const NORMAL_SIDE: Record<AccountCategory, Side> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

type Row = [code: string, name: string, reportLine: number | null];

function section(
  reportSection: ReportSection,
  category: AccountCategory,
  rows: Row[],
): SeedAccount[] {
  return rows.map(([code, name, reportLine], i) => ({
    code,
    name,
    category,
    normalSide: NORMAL_SIDE[category],
    reportSection,
    reportLine,
    sortOrder: SECTION_SORT_BASE[reportSection] + (i + 1) * 10,
  }));
}

/**
 * 個人事業の勘定科目の初期セット（data-model §2, research R10）。
 * 並びは青色申告決算書（一般用）の科目順。report_line は損益計算書の欄番号
 * （①売上（収入）金額（雑収入を含む）、⑧〜㉔ 経費、㉕〜㉚ 任意科目、㉛ 雑費）。
 * 貸借対照表の科目は欄番号を持たないため null。
 * コードの先頭の桁は区分（1 資産, 2 負債, 3 純資産, 4 収益, 5 費用）で、利用者の追加分はその続きを採番する。
 */
export const INDIVIDUAL_ACCOUNTS: readonly SeedAccount[] = [
  ...section("BS_ASSET", "asset", [
    ["1010", "現金", null],
    ["1020", "普通預金", null],
    ["1030", "売掛金", null],
    ["1040", "前払金", null],
    ["1050", "仮払金", null],
    ["1060", "工具器具備品", null],
    ["1070", "一括償却資産", null],
    ["1080", "開業費", null],
  ]),
  // 事業主貸は資産の側（末尾）に表示するが、性質は元入金の控除（純資産・借方）
  {
    code: "3090",
    name: "事業主貸",
    category: "equity",
    normalSide: "debit",
    reportSection: "BS_ASSET",
    reportLine: null,
    sortOrder: SECTION_SORT_BASE.BS_ASSET + 900,
  },
  ...section("BS_LIABILITY", "liability", [
    ["2010", "借入金", null],
    ["2020", "未払金", null],
    ["2030", "未払費用", null],
    ["2040", "前受金", null],
    ["2050", "預り金", null],
  ]),
  ...section("BS_EQUITY", "equity", [
    ["3010", "事業主借", null],
    ["3020", "元入金", null],
  ]),
  ...section("PL_SALES", "revenue", [
    ["4010", "売上高", 1],
    ["4020", "雑収入", 1],
  ]),
  ...section("PL_EXPENSE", "expense", [
    ["5080", "租税公課", 8],
    ["5090", "荷造運賃", 9],
    ["5100", "水道光熱費", 10],
    ["5110", "旅費交通費", 11],
    ["5120", "通信費", 12],
    ["5130", "広告宣伝費", 13],
    ["5140", "接待交際費", 14],
    ["5150", "損害保険料", 15],
    ["5160", "修繕費", 16],
    ["5170", "消耗品費", 17],
    ["5180", "減価償却費", 18],
    ["5190", "福利厚生費", 19],
    ["5200", "給料賃金", 20],
    ["5210", "外注工賃", 21],
    ["5220", "利子割引料", 22],
    ["5230", "地代家賃", 23],
    ["5240", "貸倒金", 24],
    // 任意科目（㉕〜㉚）。並びは過去の決算書（R7）に合わせる
    ["5250", "支払手数料", 25],
    ["5260", "会議費", 26],
    ["5270", "新聞図書費", 27],
    ["5280", "諸会費", 28],
    ["5290", "研修費", 29],
    ["5310", "雑費", 31],
  ]),
];
