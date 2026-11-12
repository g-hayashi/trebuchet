import { z } from "zod";
import { ErrorDetails } from "./errors.ts";
import { JournalInput, JournalRef } from "./journals.ts";
import {
  AmountBound,
  DateString,
  Id,
  Percent,
  QueryBool,
  QueryInt,
  QueryText,
  Sha256,
  TaxCategoryCode,
  Yen,
} from "./primitives.ts";

// 010-receipts（contracts/http-api.md §7、data-model §2.1・§2.3）

/** 1 ファイルの上限（20 MB）。server の受け取りと web の事前の検査が使う */
export const RECEIPT_MAX_BYTES = 20 * 1024 * 1024;
/** 画像の画素数の上限（1 億画素。research R10・R12。超えれば 422 `VALIDATION` の `details.maxPixels`） */
export const RECEIPT_MAX_PIXELS = 100_000_000;

/** 表示名は web の `features/receipts/labels.ts` に 1 か所。識別子は変えない（E1） */
export const ReceiptCategory = z.enum(["paper_scan", "electronic"]);
export type ReceiptCategory = z.infer<typeof ReceiptCategory>;

export const ReceiptChannel = z.enum(["local", "remote"]);
export type ReceiptChannel = z.infer<typeof ReceiptChannel>;

export const ReceiptMediaType = z.enum([
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
]);
export type ReceiptMediaType = z.infer<typeof ReceiptMediaType>;

export const ReceiptLinkState = z.enum(["none", "linked", "journal_voided"]);
export type ReceiptLinkState = z.infer<typeof ReceiptLinkState>;

export const ReceiptWarningCode = z.enum([
  "FIELDS_MISSING",
  "INPUT_PERIOD_EXCEEDED",
  "RESOLUTION_BELOW_GUIDE",
  "NOT_FULL_COLOR",
  "JOURNAL_VOIDED",
]);
export type ReceiptWarningCode = z.infer<typeof ReceiptWarningCode>;

/** `INPUT_PERIOD_EXCEEDED` は `{ deadline }`、`RESOLUTION_BELOW_GUIDE` は `{ width, height, minLong, minShort }` */
export const ReceiptWarning = z.object({
  code: ReceiptWarningCode,
  details: ErrorDetails.optional(),
});
export type ReceiptWarning = z.infer<typeof ReceiptWarning>;

const PartnerName = z.string().trim().min(1).max(100);
const Memo = z.string().max(500);
/**
 * 訂正・差し替え・削除などの理由。空欄・空白のみ・長さの判定はドメイン（001 の `checkReason`）が
 * `REASON_REQUIRED` で返すので、ここでは文字列であることだけを検証する
 */
const Reason = z.string();
const Version = z.number().int().positive();

// ---- 入力 ----

/** POST /receipts の multipart の `options`。値は任意（未入力は省くか null） */
export const ReceiptCreateOptions = z.object({
  category: ReceiptCategory,
  transactionDate: DateString.nullable().optional(),
  amount: Yen.nullable().optional(),
  partnerName: PartnerName.nullable().optional(),
  memo: Memo.nullable().optional(),
});
export type ReceiptCreateOptions = z.infer<typeof ReceiptCreateOptions>;

/** PATCH /receipts/:receiptId。未指定の項目は変えない。null で空にする（＝訂正なので理由が要る） */
export const ReceiptUpdateInput = z.object({
  category: ReceiptCategory.optional(),
  transactionDate: DateString.nullable().optional(),
  amount: Yen.nullable().optional(),
  partnerName: PartnerName.nullable().optional(),
  memo: Memo.nullable().optional(),
  reason: Reason.optional(),
  version: Version,
});
export type ReceiptUpdateInput = z.infer<typeof ReceiptUpdateInput>;

/** POST /receipts/:receiptId/files の multipart の `options` */
export const ReceiptReplaceOptions = z.object({ reason: Reason, version: Version });
export type ReceiptReplaceOptions = z.infer<typeof ReceiptReplaceOptions>;

/** POST /receipts/:receiptId/delete */
export const ReceiptDeleteInput = z.object({ reason: Reason, version: Version });
export type ReceiptDeleteInput = z.infer<typeof ReceiptDeleteInput>;

/** POST /receipts/:receiptId/link。付け替え（`replace: true`）は理由が要る */
export const ReceiptLinkInput = z.object({
  journalId: Id,
  replace: z.boolean().optional(),
  reason: Reason.optional(),
});
export type ReceiptLinkInput = z.infer<typeof ReceiptLinkInput>;

/** POST /receipts/:receiptId/unlink */
export const ReceiptUnlinkInput = z.object({ reason: Reason });
export type ReceiptUnlinkInput = z.infer<typeof ReceiptUnlinkInput>;

/** POST /receipts/:receiptId/journal（証憑から仕訳を登録する） */
export const ReceiptJournalInput = z.object({
  journal: JournalInput,
  readingId: Id.nullable().optional(),
});
export type ReceiptJournalInput = z.infer<typeof ReceiptJournalInput>;

/** パス `/receipts/:receiptId` */
export const ReceiptParam = z.object({ receiptId: Id });
export type ReceiptParam = z.infer<typeof ReceiptParam>;

/** パス `/receipts/:receiptId/files/:sha256` */
export const ReceiptFileParam = z.object({ receiptId: Id, sha256: Sha256 });
export type ReceiptFileParam = z.infer<typeof ReceiptFileParam>;

// ---- 検索（data-model §2.3。API のクエリ文字列と、URL の検索パラメーターの両方を受け付ける） ----

export const DEFAULT_RECEIPT_LIMIT = 100;

/**
 * GET /receipts の検索条件。すべて AND。結果は `received_at DESC, id DESC`。
 * `cursor` は直前のページの終わりを指す不透明な文字列
 */
export const ReceiptQuery = z.object({
  dateFrom: DateString.optional(),
  dateTo: DateString.optional(),
  amountMin: AmountBound.optional(),
  amountMax: AmountBound.optional(),
  partner: QueryText.pipe(z.string().min(1).max(100)).optional(),
  category: ReceiptCategory.optional(),
  missing: QueryBool.optional(),
  link: ReceiptLinkState.optional(),
  includeDeleted: QueryBool.default(false),
  cursor: z.string().min(1).max(200).optional(),
  limit: QueryInt.pipe(z.number().int().min(1).max(200)).default(DEFAULT_RECEIPT_LIMIT),
});
export type ReceiptQuery = z.infer<typeof ReceiptQuery>;
export type ReceiptQueryInput = z.input<typeof ReceiptQuery>;

// ---- 出力 ----

/** 証憑のファイルの版（`receipt_files` の 1 行。不変） */
export const ReceiptFileView = z.object({
  sha256: Sha256,
  fileVersion: z.number().int().positive(),
  mediaType: ReceiptMediaType,
  sizeBytes: z.number().int().positive(),
  originalName: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fullColor: z.boolean().nullable(),
  addedAt: z.string(),
  channel: ReceiptChannel,
});
export type ReceiptFileView = z.infer<typeof ReceiptFileView>;

export const ReceiptReadingStatus = z.enum(["succeeded", "invalid", "failed", "timeout"]);
export type ReceiptReadingStatus = z.infer<typeof ReceiptReadingStatus>;

/**
 * 外部の AI の読み取りの記録。`reason` は `POST …/readings` の応答だけが持つ（AI の候補の説明。
 * 保存しないので、証憑の詳細の `readings` では null）
 */
export const ReceiptReadingView = z.object({
  id: Id,
  readAt: z.string(),
  model: z.string(),
  status: ReceiptReadingStatus,
  errorCode: z.string().nullable(),
  candidates: z.object({
    transactionDate: DateString.nullable(),
    amount: Yen.nullable(),
    partnerName: z.string().nullable(),
    accountCode: z.string().nullable(),
    taxCategory: TaxCategoryCode.nullable(),
  }),
  confidence: Percent.nullable(),
  reason: z.string().nullable(),
});
export type ReceiptReadingView = z.infer<typeof ReceiptReadingView>;

/** 一覧・仕訳の詳細で使う証憑の要約 */
export const ReceiptSummary = z.object({
  id: Id,
  receivedAt: z.string(),
  channel: ReceiptChannel,
  category: ReceiptCategory,
  transactionDate: DateString.nullable(),
  amount: Yen.nullable(),
  partnerName: z.string().nullable(),
  mediaType: ReceiptMediaType,
  deleted: z.boolean(),
  linkState: ReceiptLinkState,
  journal: JournalRef.nullable(),
  warnings: z.array(ReceiptWarning),
});
export type ReceiptSummary = z.infer<typeof ReceiptSummary>;

export const ReceiptDetail = ReceiptSummary.extend({
  memo: z.string().nullable(),
  version: Version,
  currentFile: ReceiptFileView,
  files: z.array(ReceiptFileView),
  readings: z.array(ReceiptReadingView),
  deletedAt: z.string().nullable(),
  deletedReason: z.string().nullable(),
});
export type ReceiptDetail = z.infer<typeof ReceiptDetail>;

export const ReceiptHistoryTargetType = z.enum(["receipt", "receipt_link", "receipt_reading"]);
export type ReceiptHistoryTargetType = z.infer<typeof ReceiptHistoryTargetType>;

export const ReceiptHistoryAction = z.enum([
  "create",
  "update",
  "replace_file",
  "delete",
  "link",
  "unlink",
  "read",
]);
export type ReceiptHistoryAction = z.infer<typeof ReceiptHistoryAction>;

/** 証憑の履歴の 1 件（古い順）。before・after は `receipt_audit_log` の値（data-model §2.5） */
export const ReceiptHistoryEntry = z.object({
  occurredAt: z.string(),
  targetType: ReceiptHistoryTargetType,
  action: ReceiptHistoryAction,
  reason: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
});
export type ReceiptHistoryEntry = z.infer<typeof ReceiptHistoryEntry>;
