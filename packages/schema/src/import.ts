import { z } from "zod";
import { ErrorDetails } from "./errors.ts";
import { JournalStatus } from "./journals.ts";
import { MASTER_NAME_MAX } from "./masters.ts";
import { DateString, Id, Side, TaxCategoryCode, Yen } from "./primitives.ts";

// 002-freee-import（contracts/http-api.md、data-model.md）

const Count = z.number().int().nonnegative();
/** 帳票の金額（符号付きの整数。科目の通常の側を正とする） */
const Amount = z.number().int();
const FiscalYear = z.number().int().min(1900).max(9999);
/** freee の仕訳ID */
const FreeeJournalId = z.string().min(1);
/** NFKC で正規化した freee の名前（科目名・税区分名） */
const SourceName = z.string().trim().min(1, "名前を入力してください").max(200);

/** ファイルの内容の SHA-256（小文字16進64文字） */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 の形式が正しくありません");

// ---- 判定と警告のコード（data-model §3） ----

export const ImportDecision = z.enum(["new", "already", "excluded", "rejected"]);
export type ImportDecision = z.infer<typeof ImportDecision>;

export const ImportReasonCode = z.enum([
  "PRIOR_YEAR_CLOSING",
  "YEAR_NOT_SELECTED",
  "USER_EXCLUDED",
  "UNBALANCED",
  "INVALID_AMOUNT",
  "MISSING_FIELD",
  "LINE_COUNT_MISMATCH",
  "OUT_OF_PERIOD",
  "PERIOD_CLOSED",
  "UNMAPPED",
  "ACCOUNT_INACTIVE",
  "ALREADY_IMPORTED",
]);
export type ImportReasonCode = z.infer<typeof ImportReasonCode>;

/** 判定ごとに使える理由のコード。new は理由を持たない */
export const IMPORT_REASONS_BY_DECISION = {
  new: [],
  already: ["ALREADY_IMPORTED"],
  excluded: ["PRIOR_YEAR_CLOSING", "YEAR_NOT_SELECTED", "USER_EXCLUDED"],
  rejected: [
    "UNBALANCED",
    "INVALID_AMOUNT",
    "MISSING_FIELD",
    "LINE_COUNT_MISMATCH",
    "OUT_OF_PERIOD",
    "PERIOD_CLOSED",
    "UNMAPPED",
    "ACCOUNT_INACTIVE",
  ],
} as const satisfies Record<ImportDecision, readonly ImportReasonCode[]>;

export const ImportWarningCode = z.enum([
  "TAX_AMOUNT_MISMATCH",
  "TAX_CATEGORY_SUSPICIOUS",
  /** 免税の期間の TAX_CATEGORY_SUSPICIOUS を1件にまとめたもの。details は { count, freeeJournalIds }（003 R11） */
  "TAX_CATEGORY_SUSPICIOUS_EXEMPT",
  "POSSIBLE_DUPLICATE",
  "FREEE_CHANGED",
  "FREEE_DELETED",
  "NEGATIVE_OPENING",
  "OPENING_DIFFERS_FROM_CARRY_FORWARD",
]);
export type ImportWarningCode = z.infer<typeof ImportWarningCode>;

export const ImportWarning = z.object({
  code: ImportWarningCode,
  message: z.string(),
  freeeJournalId: FreeeJournalId.optional(),
  /** FREEE_CHANGED は before・after（正準 JSON） */
  details: ErrorDetails.optional(),
});
export type ImportWarning = z.infer<typeof ImportWarning>;

// ---- 入力 ----

/** プレビュー・確定の form の `options`（JSON 文字列を解析したもの） */
export const ImportOptions = z.object({
  /** 取り込む年度。省略時はファイルに含まれる、会計期間のある全年度 */
  fiscalYears: z.array(FiscalYear).optional(),
  /** 既定で対象外の仕訳（PRIOR_YEAR_CLOSING）のうち、含める freee の仕訳ID */
  include: z.array(FreeeJournalId).optional(),
  /** 個別に外す freee の仕訳ID（USER_EXCLUDED） */
  exclude: z.array(FreeeJournalId).optional(),
});
export type ImportOptions = z.infer<typeof ImportOptions>;

/** 確定の form の `expected`。画面が見たプレビューのハッシュと件数（FR-012） */
export const ImportExpected = z.object({
  fileSha256: Sha256,
  countNew: z.number().int().nonnegative(),
});
export type ImportExpected = z.infer<typeof ImportExpected>;

/** POST /imports/:batchId/void。理由の空欄の判定はドメインで行い REASON_REQUIRED を返す */
export const VoidImportInput = z.object({
  reason: z.string(),
  confirmCorrected: z.boolean().optional(),
});
export type VoidImportInput = z.infer<typeof VoidImportInput>;

// ---- 対応表 ----

const notBothSubAccount = (v: { subAccountId?: unknown; subAccountName?: unknown }) =>
  v.subAccountId === undefined || v.subAccountName === undefined;
const NOT_BOTH_SUB_ACCOUNT = {
  message: "補助科目は、既存の補助科目か新しく作る名前のどちらかを指定してください",
  path: ["subAccountName"],
};

export const AccountMapping = z
  .object({
    sourceName: SourceName,
    accountId: Id,
    subAccountId: Id.optional(),
    /** 補助科目がまだないとき、取込で作る名前 */
    subAccountName: z.string().trim().min(1).max(MASTER_NAME_MAX).optional(),
  })
  .refine(notBothSubAccount, NOT_BOTH_SUB_ACCOUNT);
export type AccountMapping = z.infer<typeof AccountMapping>;

export const TaxMapping = z.object({
  sourceName: SourceName,
  taxCategory: TaxCategoryCode,
});
export type TaxMapping = z.infer<typeof TaxMapping>;

/** GET /import-mappings の出力（保存済みのみ） */
export const ImportMappings = z.object({
  accounts: z.array(AccountMapping),
  taxes: z.array(TaxMapping),
});
export type ImportMappings = z.infer<typeof ImportMappings>;

/** PUT /import-mappings の入力（指定した行だけを追加・更新） */
export const ImportMappingsPut = z.object({
  accounts: z.array(AccountMapping).optional(),
  taxes: z.array(TaxMapping).optional(),
});
export type ImportMappingsPut = z.infer<typeof ImportMappingsPut>;

export const MappingStatus = z.enum(["saved", "proposed", "unmapped"]);
export type MappingStatus = z.infer<typeof MappingStatus>;

/**
 * ファイルに出てくる名前と対応先。科目は accountId（＋補助科目）、税区分は taxCategory。
 * unmapped は対応先を持たない
 */
export const MappingRow = z
  .object({
    sourceName: z.string(),
    status: MappingStatus,
    accountId: Id.optional(),
    subAccountId: Id.optional(),
    subAccountName: z.string().optional(),
    taxCategory: TaxCategoryCode.optional(),
  })
  .refine(notBothSubAccount, NOT_BOTH_SUB_ACCOUNT)
  .refine(
    (v) => {
      const targets = [v.accountId, v.taxCategory].filter((t) => t !== undefined).length;
      const hasSub = v.subAccountId !== undefined || v.subAccountName !== undefined;
      if (v.status === "unmapped") return targets === 0 && !hasSub;
      return targets === 1 && (!hasSub || v.accountId !== undefined);
    },
    { message: "対応先の指定が状態と合いません", path: ["status"] },
  );
export type MappingRow = z.infer<typeof MappingRow>;

// ---- プレビュー ----

/** 判定のための仕訳の下書き。新しく作る補助科目・取引先・タグは仮の ID を使う */
const DraftId = z.string().min(1);

export const ImportDraftLine = z.object({
  side: Side,
  accountId: DraftId,
  subAccountId: DraftId.optional(),
  amount: Yen,
  taxCategory: TaxCategoryCode,
  taxAmount: z.number().int().nonnegative().optional(),
  partnerId: DraftId.optional(),
  description: z.string().optional(),
  tagIds: z.array(DraftId).optional(),
});
export type ImportDraftLine = z.infer<typeof ImportDraftLine>;

export const ImportDraft = z.object({
  date: DateString,
  memo: z.string().optional(),
  lines: z.array(ImportDraftLine).min(2),
});
export type ImportDraft = z.infer<typeof ImportDraft>;

/** 仕訳ごとの判定（data-model §3）。new は下書きを持ち、それ以外は理由を持つ */
export const ImportPlanItem = z
  .object({
    freeeJournalId: FreeeJournalId,
    freeeJournalNo: z.string().nullable(),
    date: z.string(),
    decision: ImportDecision,
    reason: ImportReasonCode.optional(),
    draft: ImportDraft.optional(),
    warnings: z.array(ImportWarningCode),
    /** 判定の案内（OUT_OF_PERIOD のとき、会計期間の作成を促す文。research R19） */
    message: z.string().optional(),
  })
  .refine(
    (v) =>
      v.decision === "new"
        ? v.reason === undefined && v.draft !== undefined
        : v.reason !== undefined &&
          (IMPORT_REASONS_BY_DECISION[v.decision] as readonly string[]).includes(v.reason),
    { message: "判定と理由の組み合わせが正しくありません", path: ["reason"] },
  );
export type ImportPlanItem = z.infer<typeof ImportPlanItem>;

const DecisionCounts = z.object({
  new: Count,
  already: Count,
  excluded: Count,
  rejected: Count,
});

export const ImportPreview = z.object({
  file: z.object({
    name: z.string(),
    sha256: Sha256,
    kind: z.literal("journal"),
    encoding: z.enum(["utf-8", "shift_jis"]),
    rowCount: Count,
  }),
  years: z.array(
    z.object({
      fiscalYear: FiscalYear,
      hasPeriod: z.boolean(),
      closed: z.boolean(),
      counts: DecisionCounts,
    }),
  ),
  counts: DecisionCounts.extend({ warnings: Count }),
  /** new の仕訳の合計 */
  totals: z.object({ debit: Count, credit: Count }),
  items: z.array(ImportPlanItem),
  mappings: z.object({ accounts: z.array(MappingRow), taxes: z.array(MappingRow) }),
  toCreate: z.object({
    subAccounts: z.array(z.object({ accountId: Id, name: z.string() })),
    partners: z.array(z.string()),
    tags: z.array(z.string()),
  }),
  warnings: z.array(ImportWarning),
  /** 未定の対応がなく、new が1件以上 */
  ready: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

// ---- 取込の回（import_batches） ----

export const ImportBatchStatus = z.enum(["active", "voided"]);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;

export const ImportBatch = z
  .object({
    id: Id,
    source: z.literal("freee_journal"),
    fileName: z.string(),
    fileSha256: Sha256,
    importedAt: z.string(),
    periodFrom: DateString,
    periodTo: DateString,
    fiscalYears: z.array(FiscalYear),
    countNew: z.number().int().positive(),
    countAlready: Count,
    countExcluded: Count,
    countRejected: Count,
    countWarnings: Count,
    status: ImportBatchStatus,
    voidedAt: z.string().nullable(),
    voidReason: z.string().nullable(),
  })
  .refine((v) => v.status === "active" || (v.voidedAt !== null && v.voidReason !== null), {
    message: "取消済みの取込には取消の日時と理由が必要です",
    path: ["voidReason"],
  });
export type ImportBatch = z.infer<typeof ImportBatch>;

/** GET /imports/:batchId の仕訳の一覧の1行 */
export const ImportBatchJournal = z.object({
  journalId: Id,
  journalNo: z.number().int().positive(),
  date: DateString,
  freeeJournalId: FreeeJournalId,
  status: JournalStatus,
  version: z.number().int().positive(),
});
export type ImportBatchJournal = z.infer<typeof ImportBatchJournal>;

// ---- 期首残高の案（FR-019〜020a） ----

export const OpeningProposalRow = z.object({
  accountId: Id,
  subAccountId: Id.nullable(),
  side: Side,
  amount: Yen,
  /** この行にまとめた freee の科目名 */
  sourceNames: z.array(z.string()),
});
export type OpeningProposalRow = z.infer<typeof OpeningProposalRow>;

/** 科目・補助科目ごとの比較。金額は科目の通常の側を正とする符号付き */
export const OpeningComparison = z.object({
  accountId: Id,
  subAccountId: Id.nullable(),
  proposed: Amount,
  /** 登録済みの期首残高（FR-020）。登録がなければ null */
  registered: Amount.nullable(),
  /** 前年度の帳簿の繰越（FR-020a）。前年度の仕訳がなければ null */
  carryForward: Amount.nullable(),
});
export type OpeningComparison = z.infer<typeof OpeningComparison>;

/** 対応先の補助科目がまだない freee の科目（カードなど）。001 の補助科目の作成で解消する */
export const MissingSubAccount = z.object({
  sourceName: z.string(),
  accountId: Id,
  /** 作る補助科目の名前 */
  subAccountName: z.string(),
});
export type MissingSubAccount = z.infer<typeof MissingSubAccount>;

export const OpeningProposal = z.object({
  fiscalYear: FiscalYear,
  rows: z.array(OpeningProposalRow),
  totals: z.object({ debit: Count, credit: Count }),
  comparisons: z.array(OpeningComparison),
  /** 対応が未定の freee の科目名（missingSubAccounts の科目を含む）。この科目の行は rows に含めない */
  unmapped: z.array(z.string()),
  /** unmapped のうち、対応先の補助科目がまだないもの */
  missingSubAccounts: z.array(MissingSubAccount),
  warnings: z.array(ImportWarning),
});
export type OpeningProposal = z.infer<typeof OpeningProposal>;

// ---- 照合（FR-021〜023） ----

const ReconciliationFigures = z.object({
  opening: Amount,
  debit: Count,
  credit: Count,
  closing: Amount,
});

export const ReconciliationCause = z.enum([
  "EXCLUDED",
  "REJECTED",
  "VOIDED_IMPORT",
  "NOT_IMPORTED",
]);
export type ReconciliationCause = z.infer<typeof ReconciliationCause>;

/** 差の原因の候補（元帳の行のうち、取り消されていない参照がないもの） */
export const ReconciliationCandidate = z.object({
  date: DateString,
  freeeJournalNo: z.string().nullable(),
  debit: Count,
  credit: Count,
  cause: ReconciliationCause,
  reason: ImportReasonCode.optional(),
});
export type ReconciliationCandidate = z.infer<typeof ReconciliationCandidate>;

export const ReconciliationRow = z.object({
  accountId: Id,
  accountCode: z.string(),
  accountName: z.string(),
  /** 対応する freee の科目名 */
  sourceNames: z.array(z.string()),
  book: ReconciliationFigures,
  freee: ReconciliationFigures,
  matched: z.boolean(),
  /** 帳簿 − freee */
  difference: z.object({ opening: Amount, debit: Amount, credit: Amount, closing: Amount }),
  candidates: z.array(ReconciliationCandidate),
});
export type ReconciliationRow = z.infer<typeof ReconciliationRow>;

export const ReconciliationResult = z.object({
  rows: z.array(ReconciliationRow),
  allMatched: z.boolean(),
  unmapped: z.array(z.string()),
});
export type ReconciliationResult = z.infer<typeof ReconciliationResult>;
