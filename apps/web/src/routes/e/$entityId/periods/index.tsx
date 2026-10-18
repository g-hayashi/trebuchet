import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
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
import { api, unwrap } from "@/lib/api";
import { fiscalPeriodsQuery, queryKeys } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/periods/")({
  component: PeriodsPage,
});

const STATUS_LABELS = { open: "未締め", closed: "締め済み" } as const;

function PeriodsPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: periods, isPending, error } = useQuery(fiscalPeriodsQuery(entityId));

  const createNext = useMutation({
    mutationFn: async () =>
      (
        await unwrap(
          await api.api.entities[":entityId"]["fiscal-periods"].$post({ param: { entityId } }),
        )
      ).fiscalPeriod,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.fiscalPeriods(entityId) }),
  });

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">会計期間</h1>
      <Card>
        <CardHeader>
          <CardTitle>年度の一覧</CardTitle>
          <CardDescription>年度ごとに期首残高を登録できます。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {periods && (
            <Table>
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
                    <TableCell>{STATUS_LABELS[p.status]}</TableCell>
                    <TableCell>
                      <Link
                        to="/e/$entityId/periods/$year/opening-balances"
                        params={{ entityId, year: String(p.fiscalYear) }}
                        className="text-sm whitespace-nowrap underline-offset-4 hover:underline"
                      >
                        期首残高
                      </Link>
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
    </main>
  );
}
