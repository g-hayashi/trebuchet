/**
 * 青色申告決算書（一般用）の様式（003 research R2、data-model §2 `BlueReturnForm`）。
 * 欄番号・欄名・貸借対照表の行と科目コードの対応を、年分つきの定数で持つ。金額は扱わない。
 * 出典: 国税庁 令和7年分 青色申告決算書（一般用）
 * https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r07/10.pdf
 */

/**
 * 1ページの欄の種類。
 * - account: 科目の reportLine から金額を集める欄
 * - optional: 科目名を書く空欄（任意欄）
 * - computed: 他の欄から計算する欄
 * - unused: この機能では扱わない欄
 */
export type FormLineKind = "account" | "optional" | "computed" | "unused";

export type FormLine = {
  no: number;
  label: string;
  kind: FormLineKind;
};

export type BsSide = "asset" | "liability_equity";

/**
 * 貸借対照表の行の種類。
 * - account: 名前のある行（科目コードを対応づける）
 * - blank: 空欄の行（科目名つきで出す）
 * - income: 青色申告特別控除前の所得金額（計算）
 */
export type BsRowKind = "account" | "blank" | "income";

export type BsRow = {
  label: string;
  side: BsSide;
  kind: BsRowKind;
  accountCodes: readonly string[];
};

export type BlueReturnForm = {
  /** 適用年分（令和7年分 = 2025） */
  year: number;
  pl: readonly FormLine[];
  optionalLines: readonly number[];
  salesPartnerRows: number;
  bsRows: readonly BsRow[];
  /** 様式に行のない科目のうち、空欄の行に科目名つきで出す科目コード */
  blankRowAccountCodes: Readonly<Record<BsSide, readonly string[]>>;
};

// 要確認: T002（売上先の明細の個別の行数）
const SALES_PARTNER_ROWS_2025 = 4;
// 要確認: T002（4ページの空欄の行の数）
const BS_BLANK_ROWS_ASSET_2025 = 4;
// 要確認: T002（4ページの空欄の行の数）
const BS_BLANK_ROWS_LIABILITY_EQUITY_2025 = 3;

const line = (no: number, label: string, kind: FormLineKind): FormLine => ({ no, label, kind });

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const PL_2025: readonly FormLine[] = [
  line(1, "売上（収入）金額（雑収入を含む）", "account"),
  line(2, "期首商品（製品）棚卸高", "unused"),
  line(3, "仕入金額（製品製造原価）", "unused"),
  line(4, "小計", "unused"),
  line(5, "期末商品（製品）棚卸高", "unused"),
  line(6, "差引原価", "unused"),
  line(7, "差引金額", "unused"),
  line(8, "租税公課", "account"),
  line(9, "荷造運賃", "account"),
  line(10, "水道光熱費", "account"),
  line(11, "旅費交通費", "account"),
  line(12, "通信費", "account"),
  line(13, "広告宣伝費", "account"),
  line(14, "接待交際費", "account"),
  line(15, "損害保険料", "account"),
  line(16, "修繕費", "account"),
  line(17, "消耗品費", "account"),
  line(18, "減価償却費", "account"),
  line(19, "福利厚生費", "account"),
  line(20, "給料賃金", "account"),
  line(21, "外注工賃", "account"),
  line(22, "利子割引料", "account"),
  line(23, "地代家賃", "account"),
  line(24, "貸倒金", "account"),
  ...range(25, 30).map((no) => line(no, "", "optional")),
  line(31, "雑費", "account"),
  line(32, "計", "computed"),
  line(33, "差引金額", "computed"),
  // 要確認: T002（欄34〜42 の欄名。引当金・準備金・専従者給与等）
  ...range(34, 42).map((no) => line(no, "各種引当金・準備金等", "unused")),
  line(43, "青色申告特別控除前の所得金額", "computed"),
  line(44, "青色申告特別控除額", "computed"),
  line(45, "所得金額", "computed"),
];

const named = (label: string, side: BsSide, ...accountCodes: string[]): BsRow => ({
  label,
  side,
  kind: "account",
  accountCodes,
});

const blankRows = (count: number, side: BsSide): BsRow[] =>
  Array.from({ length: count }, () => ({ label: "", side, kind: "blank", accountCodes: [] }));

const BS_ROWS_2025: readonly BsRow[] = [
  // 資産
  named("現金", "asset", "1010"),
  named("当座預金", "asset"),
  named("定期預金", "asset"),
  named("その他の預金", "asset", "1020"),
  named("受取手形", "asset"),
  named("売掛金", "asset", "1030"),
  named("有価証券", "asset"),
  named("棚卸資産", "asset"),
  named("前払金", "asset", "1040"),
  named("貸付金", "asset"),
  named("建物", "asset"),
  named("建物附属設備", "asset"),
  named("機械装置", "asset"),
  named("車両運搬具", "asset"),
  named("工具器具備品", "asset", "1060"),
  named("土地", "asset"),
  ...blankRows(BS_BLANK_ROWS_ASSET_2025, "asset"),
  named("事業主貸", "asset", "3090"),
  // 負債・資本
  named("支払手形", "liability_equity"),
  named("買掛金", "liability_equity"),
  named("借入金", "liability_equity", "2010"),
  named("未払金", "liability_equity", "2020"),
  named("前受金", "liability_equity", "2040"),
  named("預り金", "liability_equity", "2050"),
  named("貸倒引当金", "liability_equity"),
  ...blankRows(BS_BLANK_ROWS_LIABILITY_EQUITY_2025, "liability_equity"),
  named("事業主借", "liability_equity", "3010"),
  named("元入金", "liability_equity", "3020"),
  {
    label: "青色申告特別控除前の所得金額",
    side: "liability_equity",
    kind: "income",
    accountCodes: [],
  },
];

/** 令和7年分（令和五年分以降用の様式）を基準にする。新しい様式は年分の昇順で足す */
export const BLUE_RETURN_FORMS: readonly BlueReturnForm[] = [
  {
    year: 2025,
    pl: PL_2025,
    optionalLines: range(25, 30),
    salesPartnerRows: SALES_PARTNER_ROWS_2025,
    bsRows: BS_ROWS_2025,
    // 仮払金、一括償却資産、開業費 / 未払費用（R2）
    blankRowAccountCodes: {
      asset: ["1050", "1070", "1080"],
      liability_equity: ["2030"],
    },
  },
];

/** 年度以前で最も新しい様式を返す。なければ最も古い様式（R2） */
export function formForYear(year: number): BlueReturnForm {
  let newest: BlueReturnForm | undefined;
  let oldest: BlueReturnForm | undefined;
  for (const f of BLUE_RETURN_FORMS) {
    if (oldest === undefined || f.year < oldest.year) oldest = f;
    if (f.year <= year && (newest === undefined || f.year > newest.year)) newest = f;
  }
  const found = newest ?? oldest;
  if (found === undefined) throw new Error("BLUE_RETURN_FORMS が空です");
  return found;
}
