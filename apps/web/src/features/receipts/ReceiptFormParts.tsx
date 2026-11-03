import { Link } from "@tanstack/react-router";
import type { ReceiptCategory, ReceiptDetail } from "@trebuchet/schema";
import { FieldError } from "@/components/ui/form-error";
import { ApiError } from "@/lib/api";
import { CATEGORY_HINTS, CATEGORY_LABELS, CATEGORY_OPTIONS, warningText } from "./labels";

// 証憑の追加のフォームの部品

/** 重複の応答（409）が指す既存の証憑の ID。削除済みかどうかも返る */
export function duplicateOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== "RECEIPT_DUPLICATE") return undefined;
  const id = error.details?.receiptId;
  return typeof id === "string" ? id : undefined;
}

/** 区分の選択（必須）。それぞれを選ぶ理由（`CATEGORY_HINTS`）を、選ぶ前から示す */
export function CategoryFieldset({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: ReceiptCategory | undefined;
  error: string | undefined;
  onChange: (value: ReceiptCategory) => void;
}) {
  return (
    <fieldset className="grid gap-2" aria-describedby={`${id}-category-error`}>
      <legend className="mb-1 text-sm font-medium">区分</legend>
      {CATEGORY_OPTIONS.map((option) => (
        <div key={option} className="grid gap-0.5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-category`}
              value={option}
              checked={value === option}
              aria-describedby={`${id}-${option}-hint`}
              onChange={() => onChange(option)}
            />
            {CATEGORY_LABELS[option]}
          </label>
          <p id={`${id}-${option}-hint`} className="pl-6 text-sm text-muted-foreground">
            {CATEGORY_HINTS[option]}
          </p>
        </div>
      ))}
      <FieldError id={`${id}-category-error`} message={error} />
    </fieldset>
  );
}

/** 保存の結果（201 を受けた後）。警告（入力期間・解像度・階調）が出ても保存はされている */
export function SavedNotice({ entityId, receipt }: { entityId: string; receipt: ReceiptDetail }) {
  return (
    <div role="status" className="mt-4 grid gap-2 rounded-md border px-3 py-2 text-sm">
      <p className="font-medium">保存しました。</p>
      {receipt.warnings.length > 0 && (
        <ul className="list-disc pl-5">
          {receipt.warnings.map((w) => (
            <li key={w.code}>{warningText(w)}</li>
          ))}
        </ul>
      )}
      <Link
        to="/e/$entityId/receipts/$receiptId"
        params={{ entityId, receiptId: receipt.id }}
        className="underline"
      >
        証憑を開く
      </Link>
    </div>
  );
}
