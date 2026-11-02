import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  RECEIPT_MAX_BYTES,
  type ReceiptCategory,
  type ReceiptCreateOptions,
  type ReceiptDetail,
} from "@trebuchet/schema";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { describeError } from "@/lib/api-errors";
import { parseWholeYen } from "@/lib/format";
import { postReceipt, receiptKeys } from "./api";
import { CategoryFieldset, duplicateOf, SavedNotice } from "./ReceiptFormParts";
import { useAutoReceiptReading } from "./reading";

const MAX_MB = RECEIPT_MAX_BYTES / (1024 * 1024);

/** 撮影は画像（背面カメラ）、選択は JPEG・PNG・HEIC・PDF（R16） */
const PICK_ACCEPT = "image/jpeg,image/png,image/heic,image/heif,application/pdf";

type Errors = {
  file?: string | undefined;
  category?: string | undefined;
  amount?: string | undefined;
};

type Failure = { headline: string; lines: string[] };

const NOT_SAVED = "この証憑は保存されていません。";

/** 送信の失敗の表示。どの失敗でも、保存されていないことを明示する（US2 シナリオ 4） */
function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) {
    return {
      headline: "通信できませんでした。",
      lines: [NOT_SAVED, "電波のよい場所で、もう一度送ってください。"],
    };
  }
  if (error.code === "LOCKED") {
    return {
      headline: "Mac の帳簿が施錠されています。",
      lines: [NOT_SAVED, "Mac で解錠してから、もう一度送ってください。"],
    };
  }
  if (error.status >= 500) {
    return {
      headline: "サーバーでエラーが起きました。",
      lines: [NOT_SAVED, "しばらくしてから、もう一度送ってください。"],
    };
  }
  const described = describeError(error);
  return { headline: described.message, lines: [...described.details, NOT_SAVED] };
}

/**
 * スマホからの撮影・選択（FR-006、R16）。撮影か選択でファイルを 1 つ決め、区分（必須）と、
 * 分かる値（任意）を入れて送る。保存の表示は 201 を受けた後だけ。失敗しても入力は残す
 */
export function CaptureForm({ entityId }: { entityId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<ReceiptCategory | undefined>();
  const [file, setFile] = useState<File | undefined>();
  const [transactionDate, setTransactionDate] = useState("");
  const [amount, setAmount] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState<ReceiptDetail | undefined>();
  const [pickerKey, setPickerKey] = useState(0);

  const autoRead = useAutoReceiptReading(entityId);

  const mutation = useMutation({
    mutationFn: (input: { file: File; options: ReceiptCreateOptions }) =>
      postReceipt(entityId, input.file, input.options),
    onSuccess: async ({ receipt }) => {
      setSaved(receipt);
      // 設定が有効なら、保存の直後に AI で読み取る（保存の表示は待たない）
      autoRead(receipt.id);
      setFile(undefined);
      setPickerKey((k) => k + 1);
      setTransactionDate("");
      setAmount("");
      setPartnerName("");
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
    },
  });

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.currentTarget.files?.[0];
    if (chosen === undefined) return;
    setFile(chosen);
    setErrors((prev) => ({ ...prev, file: undefined }));
  };

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
    mutation.mutate({ file, options });
  };

  const failure = mutation.isError ? failureOf(mutation.error) : undefined;
  const duplicate = duplicateOf(mutation.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>証憑を撮る</CardTitle>
      </CardHeader>
      <CardContent>
        <form aria-label="証憑を撮る" noValidate onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2" key={pickerKey}>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-camera`}>写真を撮る</Label>
              <Input
                id={`${id}-camera`}
                type="file"
                accept="image/*"
                capture="environment"
                disabled={mutation.isPending}
                onChange={choose}
                className="cursor-pointer"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={`${id}-pick`}>ファイルを選ぶ</Label>
              <Input
                id={`${id}-pick`}
                type="file"
                accept={PICK_ACCEPT}
                disabled={mutation.isPending}
                onChange={choose}
                className="cursor-pointer"
              />
              <p className="text-sm text-muted-foreground">
                JPEG・PNG・HEIC・PDF（{MAX_MB} MB まで）。
              </p>
            </div>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {file ? `選んだファイル: ${file.name}` : "ファイルが選ばれていません。"}
            </p>
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

          <div className="grid gap-4">
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
          </div>
          <p className="text-sm text-muted-foreground">
            値は分かるものだけで構いません。あとから詳細の画面で入力できます。
          </p>

          <div aria-live="assertive">
            {failure && (
              <div
                role="alert"
                className="grid gap-1 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
              >
                <p className="font-medium">{failure.headline}</p>
                {failure.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
          </div>
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
              {mutation.isPending ? "送信中…" : "送信"}
            </Button>
          </div>
        </form>

        {saved && <SavedNotice entityId={entityId} receipt={saved} />}
      </CardContent>
    </Card>
  );
}
