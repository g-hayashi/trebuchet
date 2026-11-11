import type { ReceiptDetail } from "@trebuchet/schema";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isApiError } from "@/lib/api";
import { postReceiptDelete } from "./api";
import { useReceiptWrite } from "./use-receipt-write";

/**
 * 証憑の削除（US5、FR-019）。理由つきで「削除済み」にする（行・ファイル・履歴は残り、後から開ける）。
 * 仕訳に結びついていれば server が 409 `RECEIPT_LINKED` を返すので、先に結びつきを解除するよう促す。
 * 削除済みの証憑には出さない（呼び出し側）
 */
export function ReceiptDeleteSection({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: ReceiptDetail;
}) {
  const [asking, setAsking] = useState(false);
  const [linked, setLinked] = useState(false);

  const mutation = useReceiptWrite(entityId, receipt.id, (reason: string) =>
    postReceiptDelete(entityId, receipt.id, { reason, version: receipt.version }),
  );

  return (
    <section aria-label="証憑の削除">
      <Card>
        <CardHeader>
          <CardTitle>削除</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p className="text-muted-foreground">
            削除しても、ファイルと履歴は残り、「削除済みも表示」で開けます。仕訳に結びついた証憑は、先に結びつきを解除してください。
          </p>
          {linked && (
            <p role="alert" className="text-destructive">
              この証憑は仕訳に結びついているため削除できません。先に「仕訳との結びつき」の「結びつきを解除」を行ってから、削除してください。
            </p>
          )}
          <div>
            <Button
              variant="outline"
              onClick={() => {
                setLinked(false);
                setAsking(true);
              }}
            >
              この証憑を削除
            </Button>
          </div>
        </CardContent>
      </Card>
      <ReasonDialog
        open={asking}
        title="証憑の削除"
        description="削除の理由を入力してください。理由と元の値は履歴に残ります。"
        confirmLabel="削除を確定"
        onConfirm={async (reason) => {
          try {
            await mutation.mutateAsync(reason);
          } catch (error) {
            if (isApiError(error, "RECEIPT_LINKED")) {
              setLinked(true);
              setAsking(false);
              return;
            }
            throw error;
          }
          setAsking(false);
        }}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}
