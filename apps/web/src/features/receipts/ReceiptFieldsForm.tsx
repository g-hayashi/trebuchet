import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReceiptDetail, ReceiptUpdateInput } from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { ApiError } from "@/lib/api";
import { formatYen, parseWholeYen } from "@/lib/format";
import { patchReceipt, receiptKeys } from "./api";

type Values = { transactionDate: string; amount: string; partnerName: string; memo: string };

const valuesOf = (r: ReceiptDetail): Values => ({
  transactionDate: r.transactionDate ?? "",
  amount: r.amount === null ? "" : formatYen(r.amount),
  partnerName: r.partnerName ?? "",
  memo: r.memo ?? "",
});

/**
 * 証憑の値の入力（US1: 未入力の値を埋める・メモを変える。理由は要らない）。
 * 変えた項目だけを `version` と一緒に送る。入力済みの値を変える（訂正）ときは server が
 * `REASON_REQUIRED` を返す（理由つきの訂正は US5）。業務の判定は server に任せる
 */
export function ReceiptFieldsForm({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: ReceiptDetail;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => valuesOf(receipt));
  const [amountError, setAmountError] = useState<string | undefined>();
  const [message, setMessage] = useState<"saved" | "unchanged" | undefined>();

  const mutation = useMutation({
    mutationFn: (input: ReceiptUpdateInput) => patchReceipt(entityId, receipt.id, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData(receiptKeys.detail(entityId, receipt.id), updated);
      setValues(valuesOf(updated));
      setMessage("saved");
      // 一覧・検索の結果にも反映する
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        await queryClient.invalidateQueries({
          queryKey: receiptKeys.detail(entityId, receipt.id),
        });
      }
    },
  });

  const set = (key: keyof Values) => (value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setMessage(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    mutation.reset();
    setMessage(undefined);
    const input: ReceiptUpdateInput = { version: receipt.version };

    const yen = values.amount.trim() === "" ? null : parseWholeYen(values.amount, { min: 1 });
    if (values.amount.trim() !== "" && yen === null) {
      setAmountError("1 円以上の整数で入力してください");
      return;
    }
    setAmountError(undefined);

    const date = values.transactionDate === "" ? null : values.transactionDate;
    if (date !== receipt.transactionDate) input.transactionDate = date;
    if (yen !== receipt.amount) input.amount = yen;
    const partner = values.partnerName.trim() === "" ? null : values.partnerName.trim();
    if (partner !== receipt.partnerName) input.partnerName = partner;
    const memo = values.memo.trim() === "" ? null : values.memo.trim();
    if (memo !== receipt.memo) input.memo = memo;

    if (Object.keys(input).length === 1) {
      setMessage("unchanged");
      return;
    }
    mutation.mutate(input);
  };

  return (
    <form aria-label="証憑の値" noValidate onSubmit={submit} className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        未入力の値とメモを入力できます。入力済みの値（取引年月日・金額・取引先・区分）を変えるには理由が必要です。
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1">
          <Label htmlFor={`${id}-date`}>取引年月日</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={values.transactionDate}
            onChange={(e) => set("transactionDate")(e.target.value)}
          />
        </div>
        <div className="grid content-start gap-1">
          <Label htmlFor={`${id}-amount`}>金額</Label>
          <Input
            id={`${id}-amount`}
            inputMode="numeric"
            autoComplete="off"
            className="text-right tabular-nums"
            value={values.amount}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={`${id}-amount-error`}
            onChange={(e) => {
              set("amount")(e.target.value);
              setAmountError(undefined);
            }}
          />
          <FieldError id={`${id}-amount-error`} message={amountError} />
        </div>
        <div className="grid content-start gap-1">
          <Label htmlFor={`${id}-partner`}>取引先</Label>
          <Input
            id={`${id}-partner`}
            autoComplete="off"
            maxLength={100}
            value={values.partnerName}
            onChange={(e) => set("partnerName")(e.target.value)}
          />
        </div>
        <div className="grid content-start gap-1">
          <Label htmlFor={`${id}-memo`}>メモ</Label>
          <Input
            id={`${id}-memo`}
            autoComplete="off"
            maxLength={500}
            value={values.memo}
            onChange={(e) => set("memo")(e.target.value)}
          />
        </div>
      </div>
      <ApiErrorMessage error={mutation.error} />
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "保存中…" : "保存"}
        </Button>
        <SaveNotice
          message={
            message === "saved"
              ? "保存しました。"
              : message === "unchanged"
                ? "変更がありません"
                : ""
          }
        />
      </div>
    </form>
  );
}
