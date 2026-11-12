/**
 * 初期セットの科目のコード（正本は domain の `seed/accounts.individual.ts`。値が一致することを
 * `packages/domain/test/seed-accounts.test.ts` が確かめる）。
 * 科目の ID の設定は持たず、コードで科目を引く機能（繰越・明細・請求・決算書）が共有する
 */
export const ACCOUNT_CODES = {
  /** 現金 */
  cash: "1010",
  /** 普通預金 */
  ordinaryDeposit: "1020",
  /** 売掛金 */
  receivable: "1030",
  /** 開業費（繰延資産） */
  startupCosts: "1080",
  /** 未払金（カードの科目にも使う） */
  accountsPayable: "2020",
  /** 事業主借 */
  ownerContribution: "3010",
  /** 元入金 */
  capital: "3020",
  /** 事業主貸 */
  ownerDrawing: "3090",
  /** 売上高 */
  sales: "4010",
  /** 雑収入 */
  miscIncome: "4020",
  /** 減価償却費 */
  depreciation: "5180",
  /** 支払手数料 */
  paymentFee: "5250",
  /** 固定資産除却損 */
  disposalLoss: "5300",
} as const;
