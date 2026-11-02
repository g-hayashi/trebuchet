import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  RECEIPT_MAX_BYTES,
  type ReceiptCategory,
  type ReceiptCreateOptions,
  type ReceiptDetail,
} from "@trebuchet/schema";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FilePicker } from "@/features/imports/FilePicker";
import { parseWholeYen } from "@/lib/format";
import { postReceipt, receiptKeys } from "./api";
import { CategoryFieldset, duplicateOf, SavedNotice } from "./ReceiptFormParts";

const MAX_MB = RECEIPT_MAX_BYTES / (1024 * 1024);

type Errors = {
  file?: string | undefined;
  category?: string | undefined;
  amount?: string | undefined;
};

/**
 * 証憑の追加（FR-001〜005）。画像・PDF を選び、区分（必須）と、分かる値（任意）を入れて保存する。
 * 警告（入力期間・解像度・階調）が出ても保存はされている。経路は server が決める
 */
export function ReceiptUpload({ entityId }: { entityId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<ReceiptCategory | undefined>();
  const [file, setFile] = useState<File | undefined>();
  const [transactionDate, setTransactionDate] = useState("");
  const [amount, setAmount] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [memo, setMemo] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState<ReceiptDetail | undefined>();
  const [pickerKey, setPickerKey] = useState(0);

  const mutation = useMutation({
    mutationFn: (input: { file: File; options: ReceiptCreateOptions }) =>
      postReceipt(entityId, input.file, input.options),
    onSuccess: async ({ receipt }) => {
      setSaved(receipt);
      setFile(undefined);
      setPickerKey((k) => k + 1);
      setTransactionDate("");
      setAmount("");
      setPartnerName("");
      setMemo("");
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
    },
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(undefined);
    mutation.reset();
    const next: Errors = {};
    if (file === undefined) next.file = "ファイルを選んでください";
    else if (file.size > RECEIPT_MAX_BYTES) {
      next.file = `ファイルが大きすぎます（${MAX_MB} MB まで）。`;
    }
    if (category === undefined) next.category = "区分を選んでください";
    const yen = amount.trim() === "" ? undefined : parseWholeYen(amount, { min: 1 });
    if (yen === null) next.amount = "1 円以上の整数で入力してください";
    setErrors(next);
    if (file === undefined || category === undefined || yen === null) return;
    if (next.file) return;

    const options: ReceiptCreateOptions = { category };
    if (transactionDate !== "") options.transactionDate = transactionDate;
    if (yen !== undefined) options.amount = yen;
    if (partnerName.trim() !== "") options.partnerName = partnerName.trim();
    if (memo.trim() !== "") options.memo = memo.trim();
    mutation.mutate({ file, options });
  };

  const duplicate = duplicateOf(mutation.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>証憑を追加</CardTitle>
      </CardHeader>
      <CardContent>
        <form aria-label="証憑を追加" noValidate onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1">
            <FilePicker
              key={pickerKey}
              label="証憑のファイル"
              accept=".jpg,.jpeg,.png,.heic,.pdf"
              description={`JPEG・PNG・HEIC・PDF（${MAX_MB} MB まで）。`}
              onChange={(f) => {
                setFile(f);
                setErrors((prev) => ({ ...prev, file: undefined }));
              }}
            />
            <FieldError id={`${id}-file-error`} message={errors.file} />
          </div>

          <CategoryFieldset
            id={id}
            value={category}
            error={errors.category}
            onChange={(value) => {
              setCategory(value);
              setErrors((prev) => ({ ...prev, category: undefined }));
            }}
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-date`}>取引年月日</Label>
              <Input
                id={`${id}-date`}
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
              />
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-amount`}>金額</Label>
              <Input
                id={`${id}-amount`}
                inputMode="numeric"
                autoComplete="off"
                className="text-right tabular-nums"
                value={amount}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={`${id}-amount-error`}
                onChange={(e) => setAmount(e.target.value)}
              />
              <FieldError id={`${id}-amount-error`} message={errors.amount} />
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-partner`}>取引先</Label>
              <Input
                id={`${id}-partner`}
                autoComplete="off"
                maxLength={100}
                value={partnerName}
                onChange={(e) => setPartnerName(e.target.value)}
              />
            </div>
            <div className="grid content-start gap-1">
              <Label htmlFor={`${id}-memo`}>メモ</Label>
              <Input
                id={`${id}-memo`}
                autoComplete="off"
                maxLength={500}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            値は分かるものだけで構いません。あとから詳細の画面で入力できます。
          </p>

          <ApiErrorMessage error={mutation.error} />
          {duplicate !== undefined && (
            <Link
              to="/e/$entityId/receipts/$receiptId"
              params={{ entityId, receiptId: duplicate }}
              className="text-sm underline"
            >
              同じ内容の証憑を開く
            </Link>
          )}

          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>

        {saved && <SavedNotice entityId={entityId} receipt={saved} />}
      </CardContent>
    </Card>
  );
}
