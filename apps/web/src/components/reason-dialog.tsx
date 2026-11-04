import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { ApiError } from "@/lib/api";

/**
 * 訂正・取消・締めの解除の理由を入力するダイアログ（FR-019, FR-024）。
 * 理由は空欄・500 文字超では確定できない。確定の失敗はダイアログの中に表示する
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  presets = [],
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
  presets?: readonly string[] | undefined;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>();
  const [submitting, setSubmitting] = useState(false);
  const blank = reason.trim().length === 0;
  const tooLong = reason.trim().length > 500;

  const reset = () => {
    setReason("");
    setError(undefined);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blank || tooLong) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm(reason);
      reset();
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };
  const reasonError =
    error instanceof ApiError && error.code === "REASON_REQUIRED"
      ? error.message
      : tooLong
        ? "理由は 500 文字以内で入力してください"
        : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) {
          reset();
          onCancel();
        }
      }}
    >
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {presets.length > 0 && (
            <div className="grid gap-1">
              <label htmlFor="reason-preset" className="text-sm font-medium">
                定型の理由
              </label>
              <NativeSelect
                id="reason-preset"
                value=""
                disabled={submitting}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError(undefined);
                }}
              >
                <option value="">選択してください</option>
                {presets.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid gap-1">
            <label htmlFor="reason" className="text-sm font-medium">
              理由
            </label>
            <Input
              id="reason"
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby="reason-error"
            />
            <FieldError id="reason-error" message={reasonError} />
          </div>
          {!(error instanceof ApiError && error.code === "REASON_REQUIRED") && (
            <ApiErrorMessage error={error} />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                reset();
                onCancel();
              }}
            >
              戻る
            </Button>
            <Button type="submit" disabled={blank || tooLong || submitting}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
