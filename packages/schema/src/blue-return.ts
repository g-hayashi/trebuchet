import { z } from "zod";
import { ErrorDetails } from "./errors.ts";
import { JournalInput } from "./journals.ts";
import { DateString, FiscalYearParam, Id, YEAR_PATTERN } from "./primitives.ts";

// 003-tax-return（contracts/http-api.md、data-model.md §1・§2）

/** 割合は万分率の整数（0〜10000） */
const Ratio = z.number().int().min(0).max(10000);
/** 0 以上の整数の円 */
const NonNegativeYen = z.number().int().nonnegative();
/** 帳票の金額（符号付きの整数） */
const Amount = z.number().int();
const FiscalYear = z.number().int().min(1900).max(9999);
const NonEmpty = z.string().trim().min(1, "入力してください").max(500);
/** 文字数の上限。domain の検査もこの値を使う */
export const CLOSING_NOTE_MAX = 5000;

// ---- 入力 ----

/** 決算書の CSV のクエリ（GET /blue-return/:year/csv）。`blankUnused=true` で使わない欄を空にする（R14） */
export const BlueReturnCsvQuery = z.object({
  blankUnused: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});
export type BlueReturnCsvQuery = z.infer<typeof BlueReturnCsvQuery>;

/** 家事按分の登録（PUT /blue-return/:year/home-use） */
export const HomeUseAllocationInput = z.object({
  accountId: Id,
  subAccountId: Id.nullish(),
  businessRatio: Ratio,
  /** 空は形としては受け付け、domain が 422 HOME_USE_BASIS_REQUIRED を返す（FR-012） */
  basis: z.string().max(1000),
  changeReason: z.string().max(1000).nullish(),
});
export type HomeUseAllocationInput = z.infer<typeof HomeUseAllocationInput>;

/** 地代家賃の内訳の1行（PUT /blue-return/:year/rent-details の rows） */
export const RentDetailInput = z
  .object({
    payee: NonEmpty,
    property: NonEmpty,
    annualRent: NonNegativeYen,
    deductibleAmount: NonNegativeYen,
  })
  .refine((v) => v.deductibleAmount <= v.annualRent, {
    message: "必要経費算入額は賃借料以下にしてください",
    path: ["deductibleAmount"],
  });
export type RentDetailInput = z.infer<typeof RentDetailInput>;

/** 地代家賃の内訳の置き換え（PUT /blue-return/:year/rent-details）。全件を送る */
export const RentDetailsPut = z.object({ rows: z.array(RentDetailInput).max(100) });
export type RentDetailsPut = z.infer<typeof RentDetailsPut>;

/** 償却の方法（009）。少額の特例・定額法・一括償却資産 */
export const DepreciationMethod = z.enum(["small_asset_28_2", "straight_line", "lump_sum"]);
export type DepreciationMethod = z.infer<typeof DepreciationMethod>;

/** 3 ページの行の方法。3 つの方法に開業費の任意償却（`deferred`）を足す */
export const DepreciationRowMethod = z.enum([...DepreciationMethod.options, "deferred"]);
export type DepreciationRowMethod = z.infer<typeof DepreciationRowMethod>;

/** 固定資産の登録（POST /fixed-assets）。方法の組み合わせの検査は domain（009 contracts/http-api §2） */
export const FixedAssetInput = z.object({
  name: NonEmpty,
  quantity: z.string().max(100).nullish(),
  acquiredOn: DateString,
  acquisitionCost: z.number().int().positive(),
  method: DepreciationMethod,
  usefulLifeYears: z.number().int().positive().nullish(),
  /** 事業の用に供した日。null・省略なら取得日 */
  inServiceOn: DateString.nullish(),
  /** 前年までの償却累計額 */
  priorAccumulated: z.number().int().nonnegative().default(0),
  /** 累計が何年分までか */
  priorThroughYear: FiscalYear.nullish(),
  businessRatio: Ratio,
  assetAccountId: Id,
  linkedJournalId: Id.nullish(),
  note: z.string().max(1000).nullish(),
});
export type FixedAssetInput = z.infer<typeof FixedAssetInput>;

/** 固定資産の更新（PUT /fixed-assets/:assetId）。登録の入力に変更の理由を足す */
export const FixedAssetUpdateInput = FixedAssetInput.extend({
  reason: z.string().max(1000).nullish(),
});
export type FixedAssetUpdateInput = z.infer<typeof FixedAssetUpdateInput>;

/** 固定資産の除却（POST /fixed-assets/:assetId/dispose）。物理削除はしない */
export const FixedAssetDisposeInput = z.object({
  disposedOn: DateString,
  reason: z.string().max(1000),
  /** 廃棄（除却損）か売却（事業主貸へ振替。譲渡所得は範囲外）。省略は廃棄 */
  disposalKind: z.enum(["scrap", "sale"]).default("scrap"),
});
export type FixedAssetDisposeInput = z.infer<typeof FixedAssetDisposeInput>;

/** 繰延資産（開業費）の登録（POST /deferred-assets）。勘定の区分などの検査は domain */
export const DeferredAssetInput = z.object({
  name: NonEmpty,
  totalAmount: z.number().int().positive(),
  openedOn: DateString,
  priorAccumulated: z.number().int().nonnegative().default(0),
  priorThroughYear: FiscalYear.nullish(),
  accountId: Id,
  note: z.string().max(1000).nullish(),
});
export type DeferredAssetInput = z.infer<typeof DeferredAssetInput>;

/** 開業費の更新（PUT /deferred-assets/:deferredAssetId）。登録の入力に変更の理由を足す */
export const DeferredAssetUpdateInput = DeferredAssetInput.extend({
  reason: z.string().max(1000).nullish(),
});
export type DeferredAssetUpdateInput = z.infer<typeof DeferredAssetUpdateInput>;

/** 開業費の年度ごとの償却額の決定（PUT /deferred-assets/:deferredAssetId/amortizations/:year） */
export const DeferredAmortizationInput = z.object({ amount: NonNegativeYen });
export type DeferredAmortizationInput = z.infer<typeof DeferredAmortizationInput>;

/** `/deferred-assets/:deferredAssetId/amortizations/:year` のパス（ID の形は検査しない） */
export const DeferredAmortizationParam = FiscalYearParam.extend({ deferredAssetId: z.string() });

/** 固定資産の一覧のクエリ（GET /fixed-assets）。year を付けると各資産にその年の償却の計算を付ける */
export const FixedAssetsQuery = z.object({
  year: z.string().regex(YEAR_PATTERN, "年は4桁で指定してください").transform(Number).optional(),
});
export type FixedAssetsQuery = z.infer<typeof FixedAssetsQuery>;

/** 青色申告特別控除の要件の回答（PUT /blue-return/:year/deduction-answers） */
export const DeductionAnswersInput = z.object({
  doubleEntry: z.boolean(),
  statementsAttached: z.boolean(),
  filedOnTime: z.boolean(),
  eTax: z.boolean(),
  electronicBooks: z.boolean(),
});
export type DeductionAnswersInput = z.infer<typeof DeductionAnswersInput>;

export const ClosingNoteKind = z.enum(["special_circumstances", "opening_difference"]);
export type ClosingNoteKind = z.infer<typeof ClosingNoteKind>;

/** PUT /blue-return/:year/notes/:kind のパス */
export const ClosingNoteParam = FiscalYearParam.extend({ kind: ClosingNoteKind });

export const ClosingNoteInput = z.object({ body: z.string().max(CLOSING_NOTE_MAX) });
export type ClosingNoteInput = z.infer<typeof ClosingNoteInput>;

// ---- 出力 ----

/** 003 data-model §2 の14種と 009 の 2 種（`ASSET_REGISTER_MISMATCH`・`DEPRECIATION_PARAMETER_MISSING`） */
export const BlueReturnWarningCode = z.enum([
  "OPTIONAL_LINES_OVERFLOW",
  "PL_MISMATCH",
  "HOME_USE_ADJUSTMENT_STALE",
  "RENT_DETAILS_MISMATCH",
  "DEPRECIATION_MISMATCH",
  "SALES_TOTAL_MISMATCH",
  "SALES_WITHOUT_PARTNER",
  "DUPLICATE_PARTNER_NAME",
  "OPENING_MISMATCH",
  "DEFERRED_ASSET_NOT_AMORTIZED",
  "OPENING_OWNER_ACCOUNTS",
  "NEGATIVE_BALANCE",
  "DEDUCTION_ANSWERS_MISSING",
  "PRIOR_PERIOD_OPEN",
  "ASSET_REGISTER_MISMATCH",
  "DEPRECIATION_PARAMETER_MISSING",
]);
export type BlueReturnWarningCode = z.infer<typeof BlueReturnWarningCode>;

export const BlueReturnWarning = z.object({
  code: BlueReturnWarningCode,
  message: z.string(),
  details: ErrorDetails.optional(),
});
export type BlueReturnWarning = z.infer<typeof BlueReturnWarning>;

export const AdjustmentKind = z.enum(["home_use", "depreciation", "deferred_amortization"]);
export type AdjustmentKind = z.infer<typeof AdjustmentKind>;

const HomeUseBreakdown = z.object({
  bookAmount: Amount,
  ratio: Ratio,
  business: NonNegativeYen,
  home: NonNegativeYen,
});

/** 償却の内訳（009 data-model §2.1。少額の特例も同じ形で埋める） */
const DepreciationBreakdown = z.object({
  method: DepreciationMethod,
  acquisitionCost: z.number().int().positive(),
  businessRatio: Ratio,
  depreciation: NonNegativeYen,
  deductible: NonNegativeYen,
  months: z.number().int().min(1).max(12).nullable(),
  ratePermille: z.number().int().positive().nullable(),
  openingBookValue: NonNegativeYen,
  closingBookValue: NonNegativeYen,
  disposalKind: z.enum(["scrap", "sale"]).nullable(),
  disposalAmount: NonNegativeYen,
  disposalDeductible: NonNegativeYen,
});

/** 開業費の償却の内訳（009 data-model §2.1） */
const DeferredBreakdown = z.object({
  totalAmount: z.number().int().positive(),
  openingBalance: NonNegativeYen,
  amount: NonNegativeYen,
  target: NonNegativeYen,
  closingBalance: NonNegativeYen,
});

/** 決算整理の仕訳の案。journal は年度末日付で、登録するときは 001 の仕訳の入力と同じ */
export const AdjustmentProposal = z.object({
  kind: AdjustmentKind,
  /** 按分の登録 ID、資産 ID、または開業費の ID */
  sourceId: Id,
  journal: JournalInput,
  breakdown: z.union([HomeUseBreakdown, DepreciationBreakdown, DeferredBreakdown]),
});
export type AdjustmentProposal = z.infer<typeof AdjustmentProposal>;

/** 決算整理の仕訳の案の確定（POST /blue-return/:year/adjustments）。expected.amount は画面が見た案の借方合計 */
export const AdjustmentCommitInput = z.object({
  kind: AdjustmentKind,
  sourceId: Id,
  expected: z.object({ amount: z.number().int().positive() }),
});
export type AdjustmentCommitInput = z.infer<typeof AdjustmentCommitInput>;

/** 1ページの欄の種類（様式の定義）。unused は使わない欄で、空欄の表示と CSV の対象 */
export const FormLineKind = z.enum(["account", "optional", "computed", "unused"]);
export type FormLineKind = z.infer<typeof FormLineKind>;

const FormLineAmount = z.object({
  no: z.number().int().positive(),
  label: z.string(),
  /** 空欄（回答待ちなど）は null */
  amount: Amount.nullable(),
  kind: FormLineKind,
});

const MonthlyRow = z.object({
  month: z.number().int().min(1).max(12),
  sales: Amount,
  otherIncome: Amount,
  total: Amount,
});

const RentDetailRow = z.object({
  payee: z.string(),
  property: z.string(),
  annualRent: NonNegativeYen,
  deductibleAmount: NonNegativeYen,
});

const DeductionOutput = z.object({
  cap: NonNegativeYen,
  tier: z.enum(["max", "standard", "basic"]),
  unmet: z.array(z.string()),
  amount: NonNegativeYen,
});

const SalesPartnerRow = z.object({
  partnerId: Id.nullish(),
  name: z.string(),
  amount: Amount,
});

const DepreciationRow = z.object({
  assetId: Id,
  name: z.string(),
  quantity: z.string().nullable(),
  acquiredOn: DateString,
  cost: z.number().int().positive(),
  /** 資産か開業費か。`assetId` はそれぞれの ID */
  source: z.enum(["fixed_asset", "deferred_asset"]),
  method: DepreciationRowMethod,
  usefulLifeYears: z.number().int().positive().nullable(),
  /** 償却率（千分率）。定額法だけ */
  ratePermille: z.number().int().positive().nullable(),
  /** 本年中の償却期間（月数）。定額法だけ */
  months: z.number().int().min(1).max(12).nullable(),
  /** 除却の日（年度末日までに除却したとき） */
  disposedOn: DateString.nullable(),
  base: Amount,
  ordinary: Amount,
  total: Amount,
  businessRatio: Ratio,
  deductible: Amount,
  closingBookValue: Amount,
  note: z.string().nullable(),
});

const BsRowOutput = z.object({ label: z.string(), amount: Amount.nullable() });
const BsSideOutput = z.object({ rows: z.array(BsRowOutput), total: Amount });
const BsOutput = z.object({ assets: BsSideOutput, liabilityEquity: BsSideOutput });

export const CarryForwardCheck = z.enum(["no_prior_year", "matched", "mismatched"]);
export type CarryForwardCheck = z.infer<typeof CarryForwardCheck>;

/** 青色申告決算書（一般用）。使わない欄は常に 0、空欄の表示は画面が行う（R14） */
export const BlueReturn = z.object({
  fiscalYear: FiscalYear,
  /** 使った様式の年分（R2） */
  formYear: FiscalYear,
  status: z.enum(["open", "closed"]),
  page1: z.object({ lines: z.array(FormLineAmount) }),
  page2: z.object({
    monthly: z.object({
      months: z.array(MonthlyRow),
      total: z.object({ sales: Amount, otherIncome: Amount, total: Amount }),
    }),
    rentDetails: z.array(RentDetailRow),
    /** 回答がないときは null（FR-010） */
    deduction: DeductionOutput.nullable(),
  }),
  page3: z.object({
    salesPartners: z.object({
      rows: z.array(SalesPartnerRow),
      /** 「上記以外の売上先の計」（残りの取引先・取引先なし・雑収入） */
      others: Amount,
      /** 売上先の合計（個別の行 + 上記以外の計）。欄1 と一致する（INV-24） */
      total: Amount,
      withoutPartner: z.object({ count: NonNegativeYen, amount: Amount }).nullable(),
    }),
    depreciation: z.array(DepreciationRow),
    /** 本年中における特殊事情のメモ（closing_notes の special_circumstances、FR-027）。なければ null */
    specialCircumstances: z.string().nullable(),
  }),
  page4: z.object({
    opening: BsOutput,
    closing: BsOutput,
    /** 元入金の繰越の検査（FR-029）。前の年度の帳簿がなければ no_prior_year（spec US4 シナリオ2・7） */
    carryForwardCheck: CarryForwardCheck,
    /** 期首と前期末の差の説明（closing_notes の opening_difference、FR-030）。なければ null */
    openingDifferenceNote: z.string().nullable(),
  }),
  /** 欄45（所得金額）と欄44（控除額）。回答がなければ null */
  transfer: z.object({ businessIncome: Amount.nullable(), blueDeduction: Amount.nullable() }),
  warnings: z.array(BlueReturnWarning),
});
export type BlueReturn = z.infer<typeof BlueReturn>;
