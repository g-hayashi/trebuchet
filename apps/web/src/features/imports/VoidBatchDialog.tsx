import { Link } from "@tanstack/react-router";
import type { ImportBatch, ImportBatchJournal } from "@trebuchet/schema";
import { type FormEvent, Fragment, useId, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { JournalLink } from "@/features/reports/JournalLink";
import { ApiError } from "@/lib/api";
import { voidImportBatch } from "./api";

type Corrected = { count: number; journalIds: string[] };

const numbers = (v: unknown) =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/**
 * 取込の取消のダイアログ（FR-024〜026）。理由が空欄なら確定できない。
 * 訂正済みの仕訳があると件数を示して再確認を求め、締め済みの年度があれば締めの解除を案内する
 */
export function VoidBatchDialog({
  entityId,
  batchId,
  journals,
  open,
  onCancel,
  onVoided,
}: {
  entityId: string;
  batchId: string;
  journals: readonly ImportBatchJournal[];
  open: boolean;
  onCancel: () => void;
  onVoided: (result: { batch: ImportBatch; voidedCount: number }) => void | Promise<void>;
}) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const reasonErrorId = `${id}-reason-error`;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>();
  const [corrected, setCorrected] = useState<Corrected>();
  const [submitting, setSubmitting] = useState(false);
  const blank = reason.trim().length === 0;
  const tooLong = reason.trim().length > 500;
  const activeCount = journals.filter((j) => j.status === "active").length;
  const apiError = error instanceof ApiError ? error : undefined;

  const reset = () => {
    setReason("");
    setError(undefined);
    setCorrected(undefined);
  };
  const cancel = () => {
    reset();
    onCancel();
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blank || tooLong) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await voidImportBatch(
        entityId,
        batchId,
        corrected ? { reason, confirmCorrected: true } : { reason },
      );
      reset();
      await onVoided(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CORRECTED_JOURNALS") {
        const journalIds = strings(err.details?.journalIds);
        const count = err.details?.count;
        setCorrected({ count: typeof count === "number" ? count : journalIds.length, journalIds });
      } else {
        setError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reasonError =
    apiError?.code === "REASON_REQUIRED"
      ? apiError.message
      : tooLong
        ? "理由は 500 文字以内で入力してください"
        : undefined;
  const correctedLinks = (corrected?.journalIds ?? []).flatMap((journalId) => {
    const j = journals.find((x) => x.journalId === journalId);
    return j ? [j] : [];
  });
  const closedYears =
    apiError?.code === "PERIOD_CLOSED" ? numbers(apiError.details?.fiscalYears) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) cancel();
      }}
    >
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>取込の取消</DialogTitle>
            <DialogDescription>
              この取込で登録した仕訳{activeCount}
              件をまとめて取り消します。取り消した仕訳は帳簿から除かれますが、内容と理由は変更履歴に残ります。取込で作った補助科目・取引先・メモタグと対応表は残ります。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium">
              理由
            </label>
            <Input
              id={reasonId}
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonErrorId}
            />
            <FieldError id={reasonErrorId} message={reasonError} />
          </div>
          {corrected && (
            <div
              role="alert"
              className="grid gap-1 rounded-md border border-amber-500/50 px-3 py-2 text-sm"
            >
              <p className="font-medium">取込の後に訂正された仕訳が{corrected.count}件あります。</p>
              {correctedLinks.length > 0 && (
                <p>
                  仕訳番号:{" "}
                  {correctedLinks.map((j, index) => (
                    <Fragment key={j.journalId}>
                      {index > 0 && "、"}
                      <JournalLink journalId={j.journalId} journalNo={j.journalNo} />
                    </Fragment>
                  ))}
                </p>
              )}
              <p>
                取り消すと、訂正した内容も取消になります。確かめてから「訂正済みの仕訳を含めて取り消す」を押してください。
              </p>
            </div>
          )}
          {apiError?.code === "PERIOD_CLOSED" ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
            >
              {closedYears.length > 0 ? `${closedYears.join("・")}年度は` : "取り込んだ年度が"}
              締め済みのため、この取込は取り消せません。
              <Link
                to="/e/$entityId/periods"
                params={{ entityId }}
                className="underline underline-offset-2"
              >
                会計期間
              </Link>
              の画面で締めを解除してから取り消してください。
            </div>
          ) : (
            apiError?.code !== "REASON_REQUIRED" && <ApiErrorMessage error={error} />
          )}
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={cancel}>
              戻る
            </Button>
            <Button type="submit" variant="destructive" disabled={blank || tooLong || submitting}>
              {corrected ? "訂正済みの仕訳を含めて取り消す" : "取消を確定"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
