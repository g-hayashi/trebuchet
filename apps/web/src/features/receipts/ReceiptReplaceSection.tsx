import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RECEIPT_MAX_BYTES, type ReceiptDetail } from "@trebuchet/schema";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/form-error";
import { FilePicker } from "@/features/imports/FilePicker";
import { ApiError } from "@/lib/api";
import { postReceiptFile, receiptKeys } from "./api";

const MAX_MB = RECEIPT_MAX_BYTES / (1024 * 1024);
const ACCEPT = "image/jpeg,image/png,image/heic,application/pdf,.jpg,.jpeg,.png,.heic,.pdf";

/**
 * ファイルの差し替え（撮り直し。US5、FR-018）。新しいファイルを選び、理由を添えて送る。
 * 前の版は残り、履歴から開ける。警告（解像度など）は差し替え後の証憑の警告として詳細に出る。
 * 削除済みの証憑には出さない（呼び出し側）
 */
export function ReceiptReplaceSection({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: ReceiptDetail;
}) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | undefined>();
  const [pickerKey, setPickerKey] = useState(0);
  const [asking, setAsking] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();

  const mutation = useMutation({
    mutationFn: (input: { file: File; reason: string }) =>
      postReceiptFile(entityId, receipt.id, input.file, {
        reason: input.reason,
        version: receipt.version,
      }),
    onSuccess: async ({ receipt: updated }) => {
      queryClient.setQueryData(receiptKeys.detail(entityId, receipt.id), updated);
      setFile(undefined);
      setPickerKey((k) => k + 1);
      await queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) });
    },
    onError: async (error) => {
      // 他の操作で版が進んでいたら、最新を読み直す
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        await queryClient.invalidateQueries({
          queryKey: receiptKeys.detail(entityId, receipt.id),
        });
      }
    },
  });

  const open = () => {
    if (file === undefined) return;
    if (file.size > RECEIPT_MAX_BYTES) {
      setFileError(`ファイルが大きすぎます（${MAX_MB} MB まで）。`);
      return;
    }
    setFileError(undefined);
    setAsking(true);
  };

  return (
    <section aria-label="ファイルの差し替え">
      <Card>
        <CardHeader>
          <CardTitle>ファイルの差し替え</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            撮り直したファイルに差し替えます。前のファイルは残り、履歴から開けます。
          </p>
          <FilePicker
            key={pickerKey}
            label="撮り直したファイル"
            accept={ACCEPT}
            onChange={(next) => {
              setFile(next);
              setFileError(undefined);
            }}
          />
          <FieldError id="receipt-replace-file-error" message={fileError} />
          <div>
            <Button variant="outline" disabled={file === undefined} onClick={open}>
              差し替える
            </Button>
          </div>
        </CardContent>
      </Card>
      <ReasonDialog
        open={asking}
        title="ファイルの差し替え"
        description="差し替えの理由を入力してください。前のファイルと理由は履歴に残ります。"
        confirmLabel="差し替えを確定"
        onConfirm={async (reason) => {
          if (file === undefined) return;
          await mutation.mutateAsync({ file, reason });
          setAsking(false);
        }}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}
