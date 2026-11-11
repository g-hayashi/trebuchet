import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReceiptDetail } from "@trebuchet/schema";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { invalidateLedger } from "@/lib/queries";
import { linkClass } from "@/lib/styles";
import { postReceiptUnlink } from "./api";
import { LinkJournalDialog } from "./LinkJournalDialog";

/**
 * 証憑の詳細の「仕訳との結びつき」（US3、FR-010・011・013）。結びつける・付け替える・解除する・
 * 証憑から仕訳を作る入口。削除済みの証憑には操作を出さない。
 * 結びつきの後は `invalidateLedger` で仕訳・帳票・証憑のクエリを読み直す
 */
export function ReceiptLinkSection({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: ReceiptDetail;
}) {
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const unlink = useMutation({
    mutationFn: (reason: string) => postReceiptUnlink(entityId, receipt.id, { reason }),
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });

  const { journal, linkState } = receipt;

  return (
    <section aria-label="仕訳との結びつき">
      <Card>
        <CardHeader>
          <CardTitle>仕訳との結びつき</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {linkState === "none" || journal === null ? (
            <p>仕訳に結びついていません。</p>
          ) : (
            <p>
              <Link
                to="/e/$entityId/journals/$journalId"
                params={{ entityId, journalId: journal.id }}
                aria-label={`仕訳 No.${journal.journalNo} を開く`}
                className={linkClass}
              >
                仕訳 No.{journal.journalNo}
              </Link>
              （{journal.date}）に結びついています。
              {linkState === "journal_voided" && "この仕訳は取り消されています。"}
            </p>
          )}
          {!receipt.deleted && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => setLinking(true)}>
                {linkState === "linked" ? "付け替える" : "仕訳に結びつける"}
              </Button>
              {linkState !== "linked" && (
                <Link
                  to="/e/$entityId/journals/new"
                  params={{ entityId }}
                  search={{ receiptId: receipt.id }}
                  className={linkClass}
                >
                  この証憑から仕訳を作る
                </Link>
              )}
              {linkState !== "none" && (
                <Button variant="outline" onClick={() => setUnlinking(true)}>
                  結びつきを解除
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <LinkJournalDialog
        entityId={entityId}
        receipt={receipt}
        open={linking}
        onClose={() => setLinking(false)}
      />
      <ReasonDialog
        open={unlinking}
        title="結びつきの解除"
        description="解除しても、結びつきの記録と理由は履歴に残ります。"
        confirmLabel="解除を確定"
        onConfirm={async (reason) => {
          await unlink.mutateAsync(reason);
          setUnlinking(false);
        }}
        onCancel={() => setUnlinking(false)}
      />
    </section>
  );
}
