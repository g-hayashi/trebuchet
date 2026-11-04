import type { AccountingMethod, TaxpayerStatus } from "@trebuchet/schema";

/**
 * 消費税の設定の説明の文（011 FR-050・R15）。課税区分と経理方式が何を変えるかを 1 か所に置く。
 * 帳簿の計算の規則（packages/domain の `validateJournal`・schema の `defaultTaxCategory`）と合わせる
 */

export type TaxHelp = {
  /** 画面に出す名前（設定の一覧の表示と同じ） */
  label: string;
  /** 仕訳の税区分の既定 */
  defaultCategory: string;
  /** 税額の計算 */
  calculation: string;
};

export const TAXPAYER_STATUS_HELP: Record<TaxpayerStatus, TaxHelp> = {
  exempt: {
    label: "免税",
    defaultCategory: "税区分の既定は「対象外」です。",
    calculation:
      "仕訳の税額は計算せず、請求書にも消費税を出しません。経理方式は税込経理だけ選べます。",
  },
  general: {
    label: "課税（本則）",
    defaultCategory:
      "売上は課税売上 10%、経費は課税仕入 10% が既定です。資産・負債・純資産の科目は対象外です。",
    calculation: "仕訳の貸借それぞれの税区分の税率から、税額を計算します。",
  },
  simplified: {
    label: "課税（簡易）",
    defaultCategory: "既定の税区分は本則と同じです。",
    calculation: "帳簿の計算では本則と同じ扱いです（みなし仕入率による納税額の計算はしません）。",
  },
  two_tenths: {
    label: "課税（2割特例）",
    defaultCategory: "既定の税区分は本則と同じです。",
    calculation: "帳簿の計算では本則と同じ扱いです（売上税額の 2 割を納める計算はしません）。",
  },
};

export const ACCOUNTING_METHOD_HELP: Record<AccountingMethod, TaxHelp> = {
  tax_included: {
    label: "税込経理",
    defaultCategory: "金額は税込で入力し、税区分は課税区分の既定に従います。",
    calculation: "消費税を売上・経費の金額に含めたまま記帳します。仕訳を登録できます。",
  },
  tax_excluded: {
    label: "税抜経理",
    defaultCategory: "設定として登録はできますが、その期間の仕訳は登録できません。",
    calculation:
      "税抜経理の期間の仕訳は登録できません（TAX_METHOD_UNSUPPORTED）。仮払・仮受消費税の記帳には対応していないためです。",
  },
};

/** 説明の見出し（画面の表示順） */
export const TAXPAYER_STATUS_ORDER: readonly TaxpayerStatus[] = [
  "exempt",
  "general",
  "simplified",
  "two_tenths",
];
export const ACCOUNTING_METHOD_ORDER: readonly AccountingMethod[] = [
  "tax_included",
  "tax_excluded",
];
