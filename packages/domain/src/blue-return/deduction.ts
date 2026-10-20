import type { TaxParameter, TaxParameterKey } from "../types.ts";
import { resolveTaxParameter } from "./tax-parameters.ts";

/** 青色申告特別控除の要件の回答（DeductionAnswers の回答の部分） */
export type DeductionRequirementAnswers = {
  doubleEntry: boolean;
  statementsAttached: boolean;
  filedOnTime: boolean;
  eTax: boolean;
  electronicBooks: boolean;
};

export type DeductionTier = "max" | "standard" | "basic";

export type BlueDeductionCap = {
  cap: number;
  tier: DeductionTier;
  /** 最上位の区分（max）に足りない要件の説明 */
  unmet: string[];
};

const TIER_KEY: Record<DeductionTier, TaxParameterKey> = {
  max: "BLUE_DEDUCTION_MAX",
  standard: "BLUE_DEDUCTION_STANDARD",
  basic: "BLUE_DEDUCTION_BASIC",
};

/**
 * 青色申告特別控除の上限額（research R9）。
 * 正規の簿記・BS と PL の添付・期限内の申告がすべて真で、e-Tax か優良な電子帳簿が真なら max、
 * 前の3つだけが真なら standard、それ以外は basic。回答がなければ undefined（0 として計算しない）。
 * 上限額は date（年度末日など）時点の税制の値から決める
 */
export function blueDeductionCap(
  answers: DeductionRequirementAnswers | null | undefined,
  date: string,
  params: readonly TaxParameter[],
): BlueDeductionCap | undefined {
  if (answers === null || answers === undefined) return undefined;
  const unmet: string[] = [];
  if (!answers.doubleEntry) unmet.push("正規の簿記の原則による記帳");
  if (!answers.statementsAttached) unmet.push("貸借対照表と損益計算書の添付");
  if (!answers.filedOnTime) unmet.push("期限内の申告");
  const basic3 = unmet.length === 0;
  const electronic = answers.eTax || answers.electronicBooks;
  if (!electronic) unmet.push("e-Tax での送信または優良な電子帳簿の保存");
  const tier: DeductionTier = basic3 ? (electronic ? "max" : "standard") : "basic";
  const key = TIER_KEY[tier];
  const param = resolveTaxParameter(key, date, params);
  if (param === undefined) throw new Error(`税制の値がありません: ${key}（${date}）`);
  return { cap: param.value, tier, unmet };
}

/** 青色申告特別控除額 = min(上限額, max(0, 欄43))（INV-22） */
export function blueDeduction(cap: number, incomeBefore: number): number {
  return Math.min(cap, Math.max(0, incomeBefore));
}
