import type { TaxParameter } from "../types.ts";

const NTA_2100 = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm";
const NTA_2072 = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2072.htm";
const NTA_2795 = "https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2795.htm";
const NTA_DEFENSE_WITHHOLDING_QA = "https://www.nta.go.jp/publication/pamph/pdf/0026005-024_03.pdf";
const NTA_SHITSUGI_OPENING_COST = "https://www.nta.go.jp/law/shitsugi/shotoku/04/08.htm";
const NTA_SCANNER_QA =
  "https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf";
const MOF_FY2026 = "https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_03.htm";

/**
 * 税制の値の正本（Constitution VI、research R3、data-model §1.1）。
 * DB へはマイグレーション 0003_tax_return で投入する（一致を db のテストで確認）。
 * 基準額 40万円の個人への適用開始日は 2100 の注の括弧書きと大綱からの読み取り（確度 medium）。
 * 令和9年分以後の控除の改正は、法令の確定後に適用終了日つきで行を足す（この機能では入れない）。
 */
export const TAX_PARAMETERS: readonly TaxParameter[] = [
  {
    key: "SMALL_ASSET_THRESHOLD",
    effectiveFrom: "2006-04-01",
    effectiveTo: "2026-03-31",
    value: 300_000,
    sourceUrl: NTA_2100,
  },
  {
    key: "SMALL_ASSET_THRESHOLD",
    effectiveFrom: "2026-04-01",
    effectiveTo: "2029-03-31",
    value: 400_000,
    // 2100 の注の括弧書きと、大綱（MOF）の読み取り。列は URL 1つなので大綱を持つ
    sourceUrl: MOF_FY2026,
  },
  {
    key: "SMALL_ASSET_ANNUAL_LIMIT",
    effectiveFrom: "2006-04-01",
    effectiveTo: "2029-03-31",
    value: 3_000_000,
    sourceUrl: NTA_2100,
  },
  {
    key: "BLUE_DEDUCTION_MAX",
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    value: 650_000,
    sourceUrl: NTA_2072,
  },
  {
    key: "BLUE_DEDUCTION_STANDARD",
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    value: 550_000,
    sourceUrl: NTA_2072,
  },
  {
    key: "BLUE_DEDUCTION_BASIC",
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    value: 100_000,
    sourceUrl: NTA_2072,
  },
  // 009: 一括償却資産（取得日で解決する）と開業費（開業日で解決する）。研究 R13。
  // 適用開始日は法令の施行日ではなく、009 が扱う期間（2007-04-01 以後の取得）の始め
  {
    key: "LUMP_SUM_COST_MIN",
    effectiveFrom: "2007-04-01",
    effectiveTo: null,
    value: 100_000,
    sourceUrl: NTA_2100,
  },
  {
    key: "LUMP_SUM_COST_MAX",
    effectiveFrom: "2007-04-01",
    effectiveTo: null,
    value: 200_000,
    sourceUrl: NTA_2100,
  },
  {
    key: "LUMP_SUM_YEARS",
    effectiveFrom: "2007-04-01",
    effectiveTo: null,
    value: 3,
    sourceUrl: NTA_2100,
  },
  {
    key: "OPENING_COST_AMORTIZATION_MONTHS",
    effectiveFrom: "2007-04-01",
    effectiveTo: null,
    value: 60,
    sourceUrl: NTA_SHITSUGI_OPENING_COST,
  },
  // 010: 証憑の電子保存（スキャナ保存）の期間と画素数（specs/010-receipts/data-model §1.6、research R2・R3）。
  // 出典はスキャナ一問一答（令和8年7月）。問23（最長 2 か月）・問22・23（おおむね 7 営業日）・問26（A4 相当の画素数）
  {
    key: "RECEIPT_INPUT_CYCLE_MONTHS",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    value: 2,
    sourceUrl: NTA_SCANNER_QA,
  },
  {
    key: "RECEIPT_INPUT_GRACE_BUSINESS_DAYS",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    value: 7,
    sourceUrl: NTA_SCANNER_QA,
  },
  {
    key: "RECEIPT_SCAN_MIN_LONG_PX",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    value: 2338,
    sourceUrl: NTA_SCANNER_QA,
  },
  {
    key: "RECEIPT_SCAN_MIN_SHORT_PX",
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    value: 1654,
    sourceUrl: NTA_SCANNER_QA,
  },
  // 013: 報酬・料金の源泉徴収（specs/013-withholding-tax/data-model §1.1、research R1・R2）。
  // 100 万円以下は 10.21%、超える部分は 20.42%（復興特別所得税を含む。万分率）。
  // 2026 年分まで: タックスアンサー No.2795（税率と式。頁は令和8年4月1日現在。期間の終わりは、令和9年分から防衛特別所得税が加わり復興特別所得税の率が 1.1% に下がる改正の前日）
  // 2027 年分から: 所得税・防衛特別所得税・復興特別所得税を合わせた掛け率 102.1% は変わらず率は据え置き。復興特別所得税の課税期間は 10 年延びて 2047 年まで（国税庁の源泉徴収の Q&A。PDF の本文は未確認で、確度 medium）
  {
    key: "WITHHOLDING_THRESHOLD",
    effectiveFrom: "2013-01-01",
    effectiveTo: "2026-12-31",
    value: 1_000_000,
    sourceUrl: NTA_2795,
  },
  {
    key: "WITHHOLDING_RATE_LOW",
    effectiveFrom: "2013-01-01",
    effectiveTo: "2026-12-31",
    value: 1021,
    sourceUrl: NTA_2795,
  },
  {
    key: "WITHHOLDING_RATE_HIGH",
    effectiveFrom: "2013-01-01",
    effectiveTo: "2026-12-31",
    value: 2042,
    sourceUrl: NTA_2795,
  },
  {
    key: "WITHHOLDING_THRESHOLD",
    effectiveFrom: "2027-01-01",
    effectiveTo: "2047-12-31",
    value: 1_000_000,
    sourceUrl: NTA_DEFENSE_WITHHOLDING_QA,
  },
  {
    key: "WITHHOLDING_RATE_LOW",
    effectiveFrom: "2027-01-01",
    effectiveTo: "2047-12-31",
    value: 1021,
    sourceUrl: NTA_DEFENSE_WITHHOLDING_QA,
  },
  {
    key: "WITHHOLDING_RATE_HIGH",
    effectiveFrom: "2027-01-01",
    effectiveTo: "2047-12-31",
    value: 2042,
    sourceUrl: NTA_DEFENSE_WITHHOLDING_QA,
  },
];
