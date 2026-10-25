import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  closePeriod,
  createNextPeriod,
  type FiscalPeriod,
  fiscalPeriodHistoryQuery,
  fiscalPeriodsQuery,
  periodKeys,
  reopenPeriod,
} from "@/features/periods/api";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/e/$entityId/periods/")({
  component: PeriodsPage,
});

const STATUS_LABELS = { open: "未締め", closed: "締め済み" } as const;
const ACTION_LABELS = { close: "締め", reopen: "解除" } as const;

function PeriodsPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: periods, isPending, error } = useQuery(fiscalPeriodsQuery(entityId));
  const history = useQuery(fiscalPeriodHistoryQuery(entityId));
  const [closing, setClosing] = useState<FiscalPeriod>();
  const [reopening, setReopening] = useState<FiscalPeriod>();

  // 会計期間のキーの前方一致で、一覧・履歴・期首残高をまとめて読み直す
  const invalidate = () => queryClient.invalidateQueries({ queryKey: periodKeys.list(entityId) });

  const createNext = useMutation({
    mutationFn: () => createNextPeriod(entityId),
    onSuccess: invalidate,
  });
  const close = useMutation({
    mutationFn: (year: number) => closePeriod(entityId, year),
    onSuccess: invalidate,
  });
  const reopen = useMutation({
    mutationFn: ({ year, reason }: { year: number; reason: string }) =>
      reopenPeriod(entityId, year, reason),
    onSuccess: invalidate,
  });

  const startClosing = (p: FiscalPeriod) => {
    close.reset();
    setClosing(p);
  };
  const confirmClose = async () => {
    if (!closing) return;
    try {
      await close.mutateAsync(closing.fiscalYear);
      setClosing(undefined);
    } catch {
      // エラーはダイアログの中に表示する
    }
  };
  const confirmReopen = async (reason: string) => {
    if (!reopening) return;
    await reopen.mutateAsync({ year: reopening.fiscalYear, reason });
    setReopening(undefined);
  };

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">会計期間</h1>
      <Card>
        <CardHeader>
          <CardTitle>年度の一覧</CardTitle>
          <CardDescription>
            年度ごとに期首残高を登録できます。申告が終わった年度は締めると、その年度の仕訳と期首残高を変更できなくなります。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {periods && (
            <Table aria-label="年度の一覧">
              <TableHeader>
                <TableRow>
                  <TableHead>年度</TableHead>
                  <TableHead>期間</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium tabular-nums">{p.fiscalYear}年度</TableCell>
                    <TableCell className="tabular-nums">
                      {p.startDate} 〜 {p.endDate}
                    </TableCell>
                    <TableCell>
                      {STATUS_LABELS[p.status]}
                      {p.closedAt !== null && (
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          <time dateTime={p.closedAt}>{formatDateTime(p.closedAt)}</time>に締め
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Link
                          to="/e/$entityId/periods/$year/opening-balances"
                          params={{ entityId, year: String(p.fiscalYear) }}
                          className="text-sm whitespace-nowrap underline-offset-4 hover:underline"
                        >
                          期首残高
                        </Link>
                        {p.status === "open" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`${p.fiscalYear}年度を締める`}
                            onClick={() => startClosing(p)}
                          >
                            締める
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`${p.fiscalYear}年度の締めを解除`}
                            onClick={() => setReopening(p)}
                          >
                            締めを解除
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div>
            <Button
              variant="outline"
              disabled={!periods || createNext.isPending}
              onClick={() => createNext.mutate()}
            >
              翌年度を作成
            </Button>
          </div>
          <ApiErrorMessage error={createNext.error} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>締めと解除の履歴</CardTitle>
          <CardDescription>締めと解除の操作は、日時と理由とともに記録されます。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={history.error} />
          {history.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {history.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">締めた年度はまだありません。</p>
          )}
          {history.data && history.data.length > 0 && (
            <Table aria-label="締めと解除の履歴">
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>年度</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>理由</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.data.map((h) => (
                  <TableRow key={`${h.occurredAt}-${h.fiscalYear}-${h.action}`}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <time dateTime={h.occurredAt}>{formatDateTime(h.occurredAt)}</time>
                    </TableCell>
                    <TableCell className="tabular-nums">{h.fiscalYear}年度</TableCell>
                    <TableCell>{ACTION_LABELS[h.action]}</TableCell>
                    <TableCell className="whitespace-normal">{h.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={closing !== undefined}
        onOpenChange={(next) => {
          if (!next && !close.isPending) setClosing(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{closing?.fiscalYear}年度を締める</DialogTitle>
            <DialogDescription>
              締めると、{closing?.fiscalYear}
              年度の日付の仕訳の登録・訂正・取消と、期首残高の変更ができなくなります。締めた後の誤りは、翌年度以降の訂正仕訳で直します。締めは理由を記録して解除できます。
            </DialogDescription>
          </DialogHeader>
          <ApiErrorMessage error={close.error} />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={close.isPending}
              onClick={() => setClosing(undefined)}
            >
              戻る
            </Button>
            <Button disabled={close.isPending} onClick={confirmClose}>
              締める
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={reopening !== undefined}
        title={`${reopening?.fiscalYear ?? ""}年度の締めの解除`}
        description="解除すると、この年度の仕訳と期首残高を再び変更できるようになります。解除の理由は履歴に残ります。"
        confirmLabel="解除を確定"
        onConfirm={confirmReopen}
        onCancel={() => setReopening(undefined)}
      />
    </main>
  );
}
