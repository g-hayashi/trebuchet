import { type ReceiptReadingView, TaxCategoryCode } from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import type {
  ReceiptImageTool,
  ReceiptReader,
  ReceiptReadingRequest,
  SuggestionContext,
} from "../ports.ts";
import { stripJpegMetadata } from "../receipts/jpeg-metadata.ts";
import {
  type ParsedReceiptReading,
  parseReceiptReading,
  RECEIPT_READING_ERROR,
  type ReceiptReadingErrorCode,
} from "../receipts/reading.ts";
import { buildReceiptReadingRequest, RECEIPT_AI_MAX_PX } from "../receipts/reading-prompt.ts";
import { counterAccounts } from "../statements/prompt.ts";
import {
  domainError,
  err,
  ok,
  type ReceiptFileRow,
  type ReceiptReadingRow,
  type Result,
} from "../types.ts";
import { isUnreadable, type ReceiptDeps } from "./receipts.ts";

// 外部の AI による証憑の読み取り（010 US4。contracts/domain-module.md §3、research R13・R14、FR-014〜017、INV-66・67）。
// 006 の `inferWithAi` と同じ 3 段: ① 読む（UnitOfWork）→ ② 復号・変換・AI の呼び出し（UnitOfWork の外）→ ③ 書く。
// AI の呼び出し（遅い、外部に出る）をトランザクションの中に入れない

export type ReceiptReadingDeps = ReceiptDeps & {
  images: ReceiptImageTool;
  /** 外部の AI。設定（2 つの設定が真で URL・モデル・キーがそろう）が無効なら undefined（呼ばない。INV-66） */
  reader: ReceiptReader | undefined;
};

type Candidates = ParsedReceiptReading["candidates"];

const NO_CANDIDATES: Candidates = {
  transactionDate: null,
  amount: null,
  partnerName: null,
  accountCode: null,
  taxCategory: null,
};

/** ② の結果。`reason` は応答の説明（保存しない） */
type Outcome = {
  status: ReceiptReadingRow["status"];
  errorCode: ReceiptReadingErrorCode | null;
  candidates: Candidates;
  confidence: number | null;
  reason: string | null;
};

const failure = (
  status: "failed" | "timeout" | "invalid",
  errorCode: ReceiptReadingErrorCode,
): Outcome => ({ status, errorCode, candidates: NO_CANDIDATES, confidence: null, reason: null });

/** `reader.read` の失敗が時間切れか（`details.timeout`。007 の `COLUMN_TIMEOUT_DETAIL` と同じ印） */
const isTimeout = (details: unknown): boolean =>
  typeof details === "object" &&
  details !== null &&
  (details as { timeout?: unknown }).timeout === true;

/**
 * 証憑を外部の AI で読み取り、候補を返す。候補は応答として返すだけで、証憑の値は変えない（INV-67）。
 * ① `uow.run` で証憑（ない → `RECEIPT_NOT_FOUND`、削除済み → `RECEIPT_DELETED`）・今の版・科目・税区分を読む。
 * `reader` が undefined、またはモデル名がなければ `AI_NOT_CONFIGURED`（変換も AI も呼ばない）。
 * ② `files.read` → `images.toAiJpeg` → `stripJpegMetadata` → `buildReceiptReadingRequest` → `reader.read` →
 * `parseReceiptReading`。③ `uow.run` で `receipt_readings` と履歴 `read` を書く。変換・AI の失敗も ③ で記録して
 * `ok`（`status`・`errorCode` への写像は research R13）。待つ間に証憑が削除されていたら何も書かず `RECEIPT_DELETED`。
 * ファイルを復号できなければ `RECEIPT_FILE_UNREADABLE`（AI の失敗ではないので記録しない）。
 * 読んだ版は ① で決めた `sha256`（待つ間に差し替えられても、記録はその版）
 */
export async function readReceipt(
  deps: ReceiptReadingDeps,
  receiptId: string,
): Promise<Result<ReceiptReadingView>> {
  // 1. 読む
  const read = deps.uow.run((tx) => {
    const receipt = tx.receipts.getReceipt(receiptId);
    if (receipt === undefined) {
      return err(domainError("RECEIPT_NOT_FOUND", "証憑が見つかりません"));
    }
    if (receipt.deletedAt !== null) {
      return err(domainError("RECEIPT_DELETED", "削除済みの証憑は読み取れません"));
    }
    const file = tx.receipts.listFiles(receiptId).find((f) => f.sha256 === receipt.currentSha256);
    if (file === undefined) throw new Error(`current file not found: ${receiptId}`);
    const context: SuggestionContext = {
      accounts: counterAccounts(tx.masters.listAccounts()).map((a) => ({
        code: a.code,
        name: a.name,
      })),
      taxCategories: TaxCategoryCode.options,
    };
    return ok({ file, context });
  });
  if (!read.ok) return read;
  const { file, context } = read.value;

  const { reader } = deps;
  const notConfigured = () =>
    err(domainError("AI_NOT_CONFIGURED", "外部の AI による証憑の読み取りが設定されていません"));
  if (reader === undefined) return notConfigured();
  const model = await reader.model();
  if (model === undefined) return notConfigured();

  // 2. 復号・変換・AI の呼び出し（UnitOfWork の外）
  const outcome = await recognize(deps, reader, file, context);
  if (!outcome.ok) return outcome;
  const result = outcome.value;

  // 3. 書く
  return deps.uow.run((tx) => {
    const current = tx.receipts.getReceipt(receiptId);
    if (current === undefined) {
      return err(domainError("RECEIPT_NOT_FOUND", "証憑が見つかりません"));
    }
    if (current.deletedAt !== null) {
      return err(domainError("RECEIPT_DELETED", "削除済みの証憑は読み取れません"));
    }
    const now = deps.clock.now();
    const row: ReceiptReadingRow = {
      id: deps.ids.next(),
      receiptId,
      fileSha256: file.sha256,
      readAt: now,
      model,
      status: result.status,
      errorCode: result.errorCode,
      candDate: result.candidates.transactionDate,
      candAmount: result.candidates.amount,
      candPartner: result.candidates.partnerName,
      candAccountCode: result.candidates.accountCode,
      candTaxCategory: result.candidates.taxCategory,
      confidence: result.confidence,
      comparedAt: null,
      dateMatch: null,
      amountMatch: null,
      partnerMatch: null,
      accountMatch: null,
      taxMatch: null,
    };
    tx.receipts.insertReading(row);
    tx.receipts.appendAudit(
      auditEntry(deps, {
        targetType: "receipt_reading",
        targetId: row.id,
        action: "read",
        before: null,
        // 日時・モデル名・状態だけ（候補の値・説明は入れない。US4 シナリオ 5）
        after: { receiptId, model, status: result.status },
        at: now,
      }),
    );
    return ok<ReceiptReadingView>({
      id: row.id,
      readAt: now,
      model,
      status: result.status,
      errorCode: result.errorCode,
      candidates: result.candidates,
      confidence: result.confidence,
      reason: result.reason,
    });
  });
}

/** ② 復号 → 変換 → メタデータの除去 → 要求 → AI → 検証。失敗は `Outcome` にして返す（③ で記録する） */
async function recognize(
  deps: ReceiptReadingDeps,
  reader: ReceiptReader,
  file: ReceiptFileRow,
  context: SuggestionContext,
): Promise<Result<Outcome>> {
  let bytes: Uint8Array;
  try {
    bytes = deps.files.read(file.sha256);
  } catch (e) {
    if (isUnreadable(e)) {
      return err(domainError("RECEIPT_FILE_UNREADABLE", "証憑のファイルを読めません"));
    }
    throw e;
  }

  const converted = await deps.images.toAiJpeg(bytes, file.mediaType, RECEIPT_AI_MAX_PX);
  if (!converted.ok) {
    return ok(
      failure(
        "failed",
        converted.error.code === "RECEIPT_READ_UNSUPPORTED"
          ? RECEIPT_READING_ERROR.RECEIPT_READ_UNSUPPORTED
          : RECEIPT_READING_ERROR.RECEIPT_CONVERSION_FAILED,
      ),
    );
  }
  const stripped = stripJpegMetadata(converted.value);
  if (!stripped.ok) {
    return ok(failure("failed", RECEIPT_READING_ERROR.RECEIPT_CONVERSION_FAILED));
  }

  const request: ReceiptReadingRequest = buildReceiptReadingRequest(stripped.value, context);
  const response = await reader.read(request);
  if (!response.ok) {
    return ok(
      isTimeout(response.error.details)
        ? failure("timeout", RECEIPT_READING_ERROR.AI_TIMEOUT)
        : failure("failed", RECEIPT_READING_ERROR.AI_HTTP_ERROR),
    );
  }
  const parsed = parseReceiptReading(response.value, context);
  if (parsed.status === "invalid") {
    return ok(failure("invalid", RECEIPT_READING_ERROR.AI_INVALID_OUTPUT));
  }
  return ok({
    status: "succeeded",
    errorCode: null,
    candidates: parsed.candidates,
    confidence: parsed.confidence,
    reason: parsed.reason,
  });
}
