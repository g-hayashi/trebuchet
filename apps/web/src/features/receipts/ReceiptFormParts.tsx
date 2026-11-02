import { Link } from "@tanstack/react-router";
import type { ReceiptCategory, ReceiptDetail } from "@trebuchet/schema";
import { FieldError } from "@/components/ui/form-error";
import { ApiError } from "@/lib/api";
import { CATEGORY_LABELS, CATEGORY_OPTIONS, KEEP_ORIGINAL_NOTE, warningText } from "./labels";

// 証憑の追加の画面（一覧の画面・撮影の画面）が共有する部品

/** 重複の応答（409）が指す既存の証憑の ID。削除済みかどうかも返る */
export function duplicateOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== "RECEIPT_DUPLICATE") return undefined;
  const id = error.details?.receiptId;
  return typeof id === "string" ? id : undefined;
}

/** 区分の選択（必須）。「紙を撮影」を選んだときは「紙の原本は捨てずに保存する」の注記を出す */
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
      <div className="flex flex-wrap items-center gap-4">
        {CATEGORY_OPTIONS.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-category`}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            {CATEGORY_LABELS[option]}
          </label>
        ))}
      </div>
      {value === "paper_scan" && (
        <p className="text-sm text-muted-foreground">{KEEP_ORIGINAL_NOTE}。</p>
      )}
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
