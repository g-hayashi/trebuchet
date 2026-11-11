import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RECEIPT_MAX_BYTES, type ReceiptCategory, type ReceiptDetail } from "@trebuchet/schema";
import { type FormEvent, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { describeError } from "@/lib/api-errors";
import { getStored, setStored, storageKeys } from "@/lib/local-storage";
import { postReceipt, receiptKeys, receiptQuery } from "./api";
import { RECEIPT_MAX_MB, warningText } from "./labels";
import { ReceiptFieldsForm } from "./ReceiptFieldsForm";
import { CategoryFieldset, duplicateOf } from "./ReceiptFormParts";
import { ReceiptReadingNote } from "./ReceiptReadingNote";
import { ReceiptViewer } from "./ReceiptViewer";
import { useAutoReceiptReading, useReceiptReading } from "./reading";

const PICK_ACCEPT = "image/jpeg,image/png,image/heic,image/heif,application/pdf";
function storedCategory(entityId: string): ReceiptCategory | undefined {
  const value = getStored(storageKeys.receiptCategory(entityId));
  return value === "paper_scan" || value === "electronic" ? value : undefined;
}

type UploadResult = { key: number; name: string } & (
  | { receipt: ReceiptDetail; error?: never }
  | { receipt?: never; error: unknown }
);

function failureOf(error: unknown): string {
  if (!(error instanceof ApiError))
    return "通信できませんでした。電波のよい場所で、もう一度送ってください。";
  if (error.code === "LOCKED")
    return "Mac の帳簿が施錠されています。Mac で解錠してから、もう一度送ってください。";
  if (error.status >= 500)
    return "サーバーでエラーが起きました。しばらくしてから、もう一度送ってください。";
  const described = describeError(error);
  return [described.message, ...described.details].join(" ");
}

/** 既存の1件追加APIを順に呼び、成功した証憑だけを連続入力の対象にする。 */
export function ReceiptUpload({ entityId }: { entityId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(() => storedCategory(entityId));
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<{ file?: string; category?: string }>({});
  const [results, setResults] = useState<UploadResult[]>([]);
  const [queue, setQueue] = useState<ReceiptDetail[]>([]);
  const [position, setPosition] = useState(0);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const nextResultKey = useRef(0);
  const [pickerKey, setPickerKey] = useState(0);
  const autoRead = useAutoReceiptReading(entityId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current) return;
    setErrors({
      ...(files.length === 0 ? { file: "ファイルを選んでください" } : {}),
      ...(category === undefined ? { category: "区分を選んでください" } : {}),
    });
    if (files.length === 0 || category === undefined) return;
    sending.current = true;
    setPending(true);
    const failed: File[] = [];
    try {
      for (const file of files) {
        const key = nextResultKey.current++;
        try {
          if (file.size > RECEIPT_MAX_BYTES)
            throw new Error(`ファイルが大きすぎます（${RECEIPT_MAX_MB} MB まで）。`);
          const { receipt } = await postReceipt(entityId, file, { category });
          queryClient.setQueryData(receiptKeys.detail(entityId, receipt.id), receipt);
          setResults((prev) => [...prev, { key, name: file.name, receipt }]);
          if (receipt.warnings.some((w) => w.code === "FIELDS_MISSING"))
            setQueue((prev) => [...prev, receipt]);
          autoRead(receipt.id);
        } catch (error) {
          setResults((prev) => [...prev, { key, name: file.name, error }]);
          if (duplicateOf(error) === undefined) failed.push(file);
        }
      }
      setFiles(failed);
      setPickerKey((key) => key + 1);
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
    } finally {
      sending.current = false;
      setPending(false);
    }
  };

  const current = queue[position];
  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>ファイルと区分</CardTitle>
        </CardHeader>
        <CardContent>
          <form aria-label="証憑を追加" noValidate onSubmit={submit} className="grid gap-4">
            <div className="grid min-w-0 gap-1" key={pickerKey}>
              <Label htmlFor={`${id}-pick`}>ファイルを選ぶ</Label>
              <Input
                id={`${id}-pick`}
                type="file"
                multiple
                accept={PICK_ACCEPT}
                disabled={pending}
                onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
              />
              <p className="text-sm text-muted-foreground">
                JPEG・PNG・HEIC・PDF（1件 {RECEIPT_MAX_MB} MB
                まで）。スマホでは写真の撮影も選べます。
              </p>
              <p className="break-all text-sm" aria-live="polite">
                {files.length
                  ? `${files.length}件: ${files.map((file) => file.name).join("、")}`
                  : "ファイルが選ばれていません。"}
              </p>
              <FieldError id={`${id}-file-error`} message={errors.file} />
            </div>
            <fieldset disabled={pending}>
              <CategoryFieldset
                id={id}
                value={category}
                error={errors.category}
                onChange={(value) => {
                  setCategory(value);
                  setStored(storageKeys.receiptCategory(entityId), value);
                }}
              />
            </fieldset>
            <p className="text-sm text-muted-foreground">
              追加したあと、この画面で取引年月日・金額・取引先を入力できます。
            </p>
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? "追加中…" : "追加する"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {results.length > 0 && (
        <ul aria-label="追加の結果" aria-live="polite" className="grid gap-3">
          {results.map((result) => {
            const duplicate = duplicateOf(result.error);
            return (
              <li key={result.key} className="grid min-w-0 gap-1 rounded-md border p-3 text-sm">
                <p className="break-all font-medium">{result.name}</p>
                {result.receipt ? (
                  <>
                    <p>追加しました。</p>
                    {result.receipt.warnings.map((warning) => (
                      <p key={warning.code}>{warningText(warning)}</p>
                    ))}
                    <Link
                      to="/e/$entityId/receipts/$receiptId"
                      params={{ entityId, receiptId: result.receipt.id }}
                      className="underline"
                    >
                      証憑を開く
                    </Link>
                  </>
                ) : (
                  <>
                    <p>
                      {duplicate ? "重複: " : "エラー: "}
                      {result.error instanceof Error &&
                      !(result.error instanceof ApiError) &&
                      result.error.message.startsWith("ファイルが大きすぎます")
                        ? result.error.message
                        : failureOf(result.error)}
                      この証憑は保存されていません。
                    </p>
                    {duplicate && (
                      <Link
                        to="/e/$entityId/receipts/$receiptId"
                        params={{ entityId, receiptId: duplicate }}
                        className="underline"
                      >
                        同じ内容の証憑を開く
                      </Link>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {current && (
        <ReceiptEntry
          key={current.id}
          entityId={entityId}
          initial={current}
          onNext={() => setPosition((value) => value + 1)}
        />
      )}
      {!pending && queue.length > 0 && !current && (
        <p role="status">
          追加した証憑の入力を終えました。未入力の項目は証憑の一覧から確認できます。
        </p>
      )}
    </div>
  );
}

function ReceiptEntry({
  entityId,
  initial,
  onNext,
}: {
  entityId: string;
  initial: ReceiptDetail;
  onNext: () => void;
}) {
  const query = useQuery({ ...receiptQuery(entityId, initial.id), initialData: initial });
  const receipt = query.data;
  const { usable } = useReceiptReading(receipt);
  return (
    <section aria-label="追加した証憑の値" className="grid gap-4">
      <h2 className="text-lg font-semibold">値を入力</h2>
      <ApiErrorMessage error={query.error} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ReceiptViewer entityId={entityId} receipt={receipt} />
        <div className="grid min-w-0 content-start gap-4">
          <ReceiptFieldsForm
            entityId={entityId}
            receipt={receipt}
            reading={usable}
            onNext={onNext}
          />
          <ReceiptReadingNote entityId={entityId} receipt={receipt} />
        </div>
      </div>
    </section>
  );
}
