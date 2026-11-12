import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Loading } from "@/components/loading";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { journalCountQuery } from "@/features/journals/api";
import {
  closePeriod,
  createNextPeriod,
  type FiscalPeriod,
  fiscalPeriodHistoryQuery,
  fiscalPeriodsQuery,
  openingBalancesQuery,
  periodKeys,
  reopenPeriod,
} from "@/features/periods/api";
import { formatDateTime } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/periods/")({
  component: PeriodsPage,
});

const STATUS_LABELS = { open: "未締め", closed: "締め済み" } as const;
const ACTION_LABELS = { close: "締め", reopen: "解除" } as const;

type StageProps = { label: string; children: ReactNode };

/** 年度の進め方の 1 段階。左に段階の名前、右に状態と入口 */
function Stage({ label, children }: StageProps) {
  return (
    <li
      aria-label={label}
      className="grid content-start gap-1 rounded-md border bg-muted/30 p-3 text-sm"
    >
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </li>
  );
}

const stageLinkClass = "text-sm underline-offset-4 hover:underline";

/** 年度のカード（FR-051）。期首残高 → 記帳 → 決算整理 → 締めの状態と、それぞれの入口 */
function PeriodCard({
  entityId,
  period: p,
  onClose,
  onReopen,
}: {
  entityId: string;
  period: FiscalPeriod;
  onClose: () => void;
  onReopen: () => void;
}) {
  const year = String(p.fiscalYear);
  const opening = useQuery(openingBalancesQuery(entityId, year));
  const journals = useQuery(journalCountQuery(entityId, p.startDate, p.endDate));
  const openingCount = opening.data?.openingBalances.length;

  return (
    <section aria-label={`${p.fiscalYear}年度`} className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium tabular-nums">{p.fiscalYear}年度</h2>
        <span className="text-sm text-muted-foreground tabular-nums">
          {p.startDate} 〜 {p.endDate}
        </span>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stage label="期首残高">
          <span>
            {openingCount === undefined
              ? "読み込み中…"
              : openingCount > 0
                ? `登録済み（${openingCount} 行）`
                : "未登録"}
          </span>
          <Link
            to="/e/$entityId/periods/$year/opening-balances"
            params={{ entityId, year }}
            className={stageLinkClass}
          >
            期首残高を開く
          </Link>
        </Stage>
        <Stage label="記帳">
          <span>
            {journals.data === undefined
              ? "読み込み中…"
              : `仕訳 ${journals.data.toLocaleString("ja-JP")} 件`}
          </span>
          <Link
            to="/e/$entityId/journals"
            params={{ entityId }}
            search={{ dateFrom: p.startDate, dateTo: p.endDate }}
            className={stageLinkClass}
          >
            仕訳を見る
          </Link>
        </Stage>
        <Stage label="決算整理">
          <Link
            to="/e/$entityId/blue-return/$year"
            params={{ entityId, year }}
            className={stageLinkClass}
          >
            決算書を開く
          </Link>
        </Stage>
        <Stage label="締め">
          <span>
            {STATUS_LABELS[p.status]}
            {p.closedAt !== null && (
              <span className="block text-xs text-muted-foreground tabular-nums">
                <time dateTime={p.closedAt}>{formatDateTime(p.closedAt)}</time>に締め
              </span>
            )}
          </span>
          {p.status === "open" ? (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              aria-label={`${p.fiscalYear}年度を締める`}
              onClick={onClose}
            >
              締める
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              aria-label={`${p.fiscalYear}年度の締めを解除`}
              onClick={onReopen}
            >
              締めを解除
            </Button>
          )}
        </Stage>
      </ol>
    </section>
  );
}

function PeriodsPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: periods, isPending, error } = useQuery(fiscalPeriodsQuery(entityId));
  const history = useQuery(fiscalPeriodHistoryQuery(entityId));
  const [closing, setClosing] = useState<FiscalPeriod>();
  const [reopening, setReopening] = useState<FiscalPeriod>();

  // 会計期間のキーの前方一致で、一覧・履歴・期首残高をまとめて読み直す
  const invalidate = () => queryClient.invalidateQueries({ queryKey: periodKeys.list(entityId) });
  // 締め・解除は帳票・決算書・ホーム（締めの状態・知らせ）にも関わる
  const invalidateAll = () => Promise.all([invalidate(), invalidateLedger(queryClient, entityId)]);

  const createNext = useMutation({
    mutationFn: () => createNextPeriod(entityId),
    onSuccess: invalidate,
  });
  const close = useMutation({
    mutationFn: (year: number) => closePeriod(entityId, year),
    onSuccess: invalidateAll,
  });
  const reopen = useMutation({
    mutationFn: ({ year, reason }: { year: number; reason: string }) =>
      reopenPeriod(entityId, year, reason),
    onSuccess: invalidateAll,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">会計期間</h1>
        <Link
          to="/e/$entityId/imports"
          params={{ entityId }}
          className={buttonVariants({ variant: "outline" })}
        >
          freee の取込
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>年度の一覧</CardTitle>
          <CardDescription>
            年度ごとに「期首残高 → 記帳 → 決算整理 →
            締め」の順に進めます。申告が終わった年度は締めると、その年度の仕訳と期首残高を変更できなくなります。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {isPending && <Loading />}
          {periods && (
            <div className="grid gap-4">
              {periods.map((p) => (
                <PeriodCard
                  key={p.id}
                  entityId={entityId}
                  period={p}
                  onClose={() => startClosing(p)}
                  onReopen={() => setReopening(p)}
                />
              ))}
            </div>
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
          {history.isPending && <Loading />}
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

      <ConfirmDialog
        open={closing !== undefined}
        onOpenChange={(next) => {
          if (!next && !close.isPending) setClosing(undefined);
        }}
        title={<>{closing?.fiscalYear}年度を締める</>}
        description={
          <>
            締めると、{closing?.fiscalYear}
            年度の日付の仕訳の登録・訂正・取消と、期首残高の変更ができなくなります。締めた後の誤りは、翌年度以降の訂正仕訳で直します。締めは理由を記録して解除できます。
          </>
        }
        cancelLabel="戻る"
        confirmLabel="締める"
        cancelDisabled={close.isPending}
        confirmDisabled={close.isPending}
        onCancel={() => setClosing(undefined)}
        onConfirm={confirmClose}
      >
        <ApiErrorMessage error={close.error} />
      </ConfirmDialog>
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
