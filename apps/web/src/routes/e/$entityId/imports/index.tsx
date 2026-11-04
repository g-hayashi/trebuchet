import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { importsQuery } from "@/features/imports/api";
import { LedgerShortcuts } from "@/features/imports/LedgerShortcuts";
import { BATCH_STATUS_LABELS, DECISION_LABELS } from "@/features/imports/labels";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/imports/")({
  component: ImportsPage,
});

/** 取込の履歴（FR-013）。API の順（新しい順）に並べる */
function ImportsPage() {
  const { entityId } = Route.useParams();
  const { data: batches, error } = useQuery(importsQuery(entityId));

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">取込</h1>
        <Link
          to="/e/$entityId/imports/new"
          params={{ entityId }}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          新しい取込
        </Link>
      </div>
      <LedgerShortcuts entityId={entityId} />
      <Card>
        <CardHeader>
          <CardTitle>取込の履歴</CardTitle>
          <CardDescription>freee の仕訳帳から取り込んだ記録です。</CardDescription>
        </CardHeader>
        <CardContent>
          <ApiErrorMessage error={error} />
          {batches?.length === 0 && (
            <p className="text-sm text-muted-foreground">まだ取込はありません。</p>
          )}
          {batches && batches.length > 0 && (
            <Table aria-label="取込の履歴">
              <TableHeader>
                <TableRow>
                  <TableHead>取込日時</TableHead>
                  <TableHead>ファイル名</TableHead>
                  <TableHead>期間</TableHead>
                  <TableHead>件数</TableHead>
                  <TableHead>状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow
                    key={b.id}
                    className={cn(b.status === "voided" && "text-muted-foreground")}
                  >
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatDateTime(b.importedAt)}
                    </TableCell>
                    <TableCell>
                      <Link
                        to="/e/$entityId/imports/$batchId"
                        params={{ entityId, batchId: b.id }}
                        className="underline-offset-4 hover:underline"
                      >
                        {b.fileName}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {b.periodFrom} 〜 {b.periodTo}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <span className="font-medium">{b.countNew}件</span>
                      <span className="block text-xs text-muted-foreground">
                        {DECISION_LABELS.already} {b.countAlready}件・{DECISION_LABELS.excluded}{" "}
                        {b.countExcluded}件・{DECISION_LABELS.rejected} {b.countRejected}件
                      </span>
                    </TableCell>
                    <TableCell>{BATCH_STATUS_LABELS[b.status]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
