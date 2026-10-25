import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { entityKeys } from "@/features/entities/api";
import { importBatchQuery } from "@/features/imports/api";
import { BATCH_STATUS_LABELS, DECISION_LABELS } from "@/features/imports/labels";
import { VoidBatchDialog } from "@/features/imports/VoidBatchDialog";
import { JournalLink } from "@/features/reports/JournalLink";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/imports/$batchId")({
  component: ImportBatchPage,
});

/** 取込の詳細（FR-013）。取込の概要と、その取込で登録した仕訳。有効な取込は取り消せる（FR-024） */
function ImportBatchPage() {
  const { entityId, batchId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data, error } = useQuery(importBatchQuery(entityId, batchId));
  const batch = data?.batch;
  const [voiding, setVoiding] = useState(false);
  const [voidedCount, setVoidedCount] = useState<number>();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          {batch ? `取込の詳細: ${batch.fileName}` : "取込の詳細"}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/e/$entityId/imports"
            params={{ entityId }}
            className="text-sm underline-offset-4 hover:underline"
          >
            取込の履歴へ
          </Link>
          {batch?.status === "active" && (
            <Button variant="outline" onClick={() => setVoiding(true)}>
              取込を取り消す
            </Button>
          )}
        </div>
      </div>
      <ApiErrorMessage error={error} />
      {voidedCount !== undefined && (
        <p role="status" className="rounded-md border border-emerald-600/50 px-4 py-3 text-sm">
          {voidedCount}件の仕訳を取り消しました。同じファイルを、改めて取り込めます。
        </p>
      )}
      {batch && data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>概要</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted-foreground">取込日時</dt>
                <dd className="tabular-nums">{formatDateTime(batch.importedAt)}</dd>
                <dt className="text-muted-foreground">期間</dt>
                <dd className="tabular-nums">
                  {batch.periodFrom} 〜 {batch.periodTo}（{batch.fiscalYears.join("・")}年）
                </dd>
                <dt className="text-muted-foreground">件数</dt>
                <dd className="tabular-nums">
                  {DECISION_LABELS.new} {batch.countNew}件・{DECISION_LABELS.already}{" "}
                  {batch.countAlready}件・{DECISION_LABELS.excluded} {batch.countExcluded}件・
                  {DECISION_LABELS.rejected} {batch.countRejected}件・警告 {batch.countWarnings}件
                </dd>
                <dt className="text-muted-foreground">状態</dt>
                <dd className={cn(batch.status === "voided" && "text-destructive")}>
                  {BATCH_STATUS_LABELS[batch.status]}
                  {batch.voidedAt && `（${formatDateTime(batch.voidedAt)}）`}
                  {batch.voidReason && `: ${batch.voidReason}`}
                </dd>
                <dt className="text-muted-foreground">ファイルのハッシュ</dt>
                <dd className="font-mono text-xs break-all">{batch.fileSha256}</dd>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>取り込んだ仕訳</CardTitle>
            </CardHeader>
            <CardContent>
              {data.journals.length === 0 ? (
                <p className="text-sm text-muted-foreground">取り込んだ仕訳はありません。</p>
              ) : (
                <Table aria-label="取り込んだ仕訳">
                  <TableHeader>
                    <TableRow>
                      <TableHead>仕訳番号</TableHead>
                      <TableHead>日付</TableHead>
                      <TableHead>freee の仕訳ID</TableHead>
                      <TableHead>状態</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.journals.map((j) => (
                      <TableRow
                        key={j.journalId}
                        className={cn(j.status === "voided" && "text-muted-foreground")}
                      >
                        <TableCell className="tabular-nums">
                          <JournalLink journalId={j.journalId} journalNo={j.journalNo} />
                        </TableCell>
                        <TableCell className="tabular-nums">{j.date}</TableCell>
                        <TableCell className="font-mono text-xs">{j.freeeJournalId}</TableCell>
                        <TableCell>{j.status === "voided" ? "取消済み" : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {data && (
        <VoidBatchDialog
          entityId={entityId}
          batchId={batchId}
          journals={data.journals}
          open={voiding}
          onCancel={() => setVoiding(false)}
          onVoided={async (result) => {
            setVoiding(false);
            setVoidedCount(result.voidedCount);
            await queryClient.invalidateQueries({ queryKey: entityKeys.entity(entityId) });
          }}
        />
      )}
    </main>
  );
}
