import type { ReceiptLinkState, ReceiptWarning } from "@trebuchet/schema";
import { resolveTaxParameter } from "../blue-return/tax-parameters.ts";
import { addBusinessDays, addDays, addMonthsToDate } from "../dates.ts";
import type { ReceiptFileRow, ReceiptRow, TaxParameter, TaxParameterKey } from "../types.ts";

// 証憑の警告（data-model §2.2、research R2・R3）。保存は拒まず、画面に示すだけ

/** 入力期間の判定に使う、解決済みの税制の値（R2） */
export type InputPeriodParams = { cycleMonths: number; graceBusinessDays: number };

/**
 * 紙を撮影した証憑の入力の期限（業務処理サイクル方式の最長、R2）。
 * `addBusinessDays(addDays(addMonthsToDate(取引年月日, M), -1), N)`。営業日は土日を除く
 */
export function inputDeadline(transactionDate: string, params: InputPeriodParams): string {
  const cycleEnd = addDays(addMonthsToDate(transactionDate, params.cycleMonths), -1);
  return addBusinessDays(cycleEnd, params.graceBusinessDays);
}

export type ReceiptWarningInput = {
  receipt: ReceiptRow;
  /** 今の版のファイル */
  currentFile: ReceiptFileRow;
  linkState: ReceiptLinkState;
  /** 受領日時を `Asia/Tokyo` の日付にしたもの（`ReceiptDeps.dateOf`。domain は `Date`・`Intl` を使わない） */
  receivedDate: string;
  taxParameters: readonly TaxParameter[];
};

/**
 * 警告の一覧。削除済みは空。並びは 未入力 → 入力期間 → 解像度 → 階調 → 仕訳の取消。
 * 税制の値を解決できない警告（入力期間・解像度）は出さない
 */
export function receiptWarnings(input: ReceiptWarningInput): ReceiptWarning[] {
  const { receipt, currentFile, linkState, receivedDate, taxParameters } = input;
  if (receipt.deletedAt !== null) return [];
  const warnings: ReceiptWarning[] = [];
  const paramValue = (key: TaxParameterKey, date: string): number | undefined =>
    resolveTaxParameter(key, date, taxParameters)?.value;

  if (receipt.transactionDate === null || receipt.amount === null || receipt.partnerName === null) {
    warnings.push({ code: "FIELDS_MISSING" });
  }

  const paper = receipt.category === "paper_scan";

  if (paper && receipt.transactionDate !== null) {
    const cycleMonths = paramValue("RECEIPT_INPUT_CYCLE_MONTHS", receipt.transactionDate);
    const graceBusinessDays = paramValue(
      "RECEIPT_INPUT_GRACE_BUSINESS_DAYS",
      receipt.transactionDate,
    );
    if (cycleMonths !== undefined && graceBusinessDays !== undefined) {
      const deadline = inputDeadline(receipt.transactionDate, { cycleMonths, graceBusinessDays });
      if (receivedDate > deadline) {
        warnings.push({ code: "INPUT_PERIOD_EXCEEDED", details: { deadline } });
      }
    }
  }

  const { width, height } = currentFile;
  if (paper && width !== null && height !== null && currentFile.mediaType !== "application/pdf") {
    const on = receipt.transactionDate ?? receivedDate;
    const minLong = paramValue("RECEIPT_SCAN_MIN_LONG_PX", on);
    const minShort = paramValue("RECEIPT_SCAN_MIN_SHORT_PX", on);
    if (
      minLong !== undefined &&
      minShort !== undefined &&
      (Math.max(width, height) < minLong || Math.min(width, height) < minShort)
    ) {
      warnings.push({
        code: "RESOLUTION_BELOW_GUIDE",
        details: { width, height, minLong, minShort },
      });
    }
  }

  if (paper && currentFile.fullColor === false) warnings.push({ code: "NOT_FULL_COLOR" });

  if (linkState === "journal_voided") warnings.push({ code: "JOURNAL_VOIDED" });

  return warnings;
}
