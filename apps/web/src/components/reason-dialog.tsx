import { type FormEvent, type ReactNode, useId, useState } from "react";
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
import { isApiError } from "@/lib/api";
import { REASON_MAX } from "@/lib/limits";

/**
 * 訂正・取消・締めの解除の理由を入力するダイアログ（FR-019, FR-024）。
 * 理由は空欄・500 文字超では確定できない。確定の失敗はダイアログの中に表示する
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmVariant,
  onConfirm,
  onCancel,
  presets = [],
  children,
  onConfirmError,
  renderError,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive" | undefined;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
  presets?: readonly string[] | undefined;
  /** 理由の欄とエラーの間に置く表示（確認の追加の情報など） */
  children?: ReactNode;
  /**
   * 確定の失敗を呼び出し側で扱う（例: 取消の CORRECTED_JOURNALS で再確認を求める）。
   * true を返したら、エラーを表示せず理由を残して、ダイアログを開いたままにする
   */
  onConfirmError?: ((error: unknown) => boolean) | undefined;
  /** 確定の失敗の表示を差し替える。undefined を返したら既定の表示（ApiErrorMessage）にする */
  renderError?: ((error: unknown) => ReactNode | undefined) | undefined;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>();
  const [submitting, setSubmitting] = useState(false);
  const blank = reason.trim().length === 0;
  const tooLong = reason.trim().length > REASON_MAX;

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
      if (!onConfirmError?.(err)) setError(err);
    } finally {
      setSubmitting(false);
    }
  };
  const reasonRequired = isApiError(error, "REASON_REQUIRED");
  const reasonError = reasonRequired
    ? error.message
    : tooLong
      ? `理由は ${REASON_MAX} 文字以内で入力してください`
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
              <label htmlFor={`${id}-preset`} className="text-sm font-medium">
                定型の理由
              </label>
              <NativeSelect
                id={`${id}-preset`}
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
            <label htmlFor={`${id}-reason`} className="text-sm font-medium">
              理由
            </label>
            <Input
              id={`${id}-reason`}
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={`${id}-reason-error`}
            />
            <FieldError id={`${id}-reason-error`} message={reasonError} />
          </div>
          {children}
          {!reasonRequired && (renderError?.(error) ?? <ApiErrorMessage error={error} />)}
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
            <Button
              type="submit"
              variant={confirmVariant}
              disabled={blank || tooLong || submitting}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
