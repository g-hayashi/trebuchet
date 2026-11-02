import type { FixedAssetRow } from "./api";

export type AssetMethod = FixedAssetRow["method"];

/** 償却の方法の選択肢の表示名（登録・編集の入力欄） */
export const METHOD_OPTIONS: readonly { value: AssetMethod; label: string }[] = [
  { value: "small_asset_28_2", label: "少額減価償却資産の特例（措置法28条の2）" },
  { value: "straight_line", label: "定額法" },
  { value: "lump_sum", label: "一括償却資産（3年均等）" },
];

/** 台帳の一覧の表示名（短い形） */
export const METHOD_SHORT_LABELS: Record<AssetMethod, string> = {
  small_asset_28_2: "少額の特例",
  straight_line: "定額法",
  lump_sum: "一括償却",
};

/** 償却を計算できない理由（depreciationError.code）の表示 */
export function depreciationErrorText(code: string): string {
  switch (code) {
    case "USEFUL_LIFE_UNSUPPORTED":
      return "耐用年数が償却率の表にありません";
    case "TAX_PARAMETER_MISSING":
      return "該当する税制の値がありません";
    case "PRIOR_ACCUMULATED_INVALID":
      return "前年までの償却累計額が正しくありません";
    default:
      return code;
  }
}
