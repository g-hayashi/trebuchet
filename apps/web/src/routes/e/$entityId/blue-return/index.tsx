import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { fiscalPeriodsQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/blue-return/")({
  component: BlueReturnListPage,
});

/** 青色申告決算書の年度の一覧。会計期間ごとに決算書の画面へ進む */
function BlueReturnListPage() {
  const { entityId } = Route.useParams();
  const { data: periods, isPending, error } = useQuery(fiscalPeriodsQuery(entityId));
  const sorted = periods && [...periods].sort((a, b) => b.fiscalYear - a.fiscalYear);

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">青色申告決算書</h1>
      <Card>
        <CardHeader>
          <CardTitle>年分の一覧</CardTitle>
          <CardDescription>
            年分を選ぶと、決算書と確定申告書に転記する値を確かめられます。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ApiErrorMessage error={error} />
          {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
          {sorted?.length === 0 && (
            <p className="text-sm text-muted-foreground">会計期間がありません。</p>
          )}
          <ul className="grid gap-2">
            {sorted?.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3">
                <Link
                  to="/e/$entityId/blue-return/$year"
                  params={{ entityId, year: String(p.fiscalYear) }}
                  className="underline"
                >
                  {p.fiscalYear}年分
                </Link>
                <span className="text-sm text-muted-foreground">
                  {p.startDate} 〜 {p.endDate}
                </span>
                <span className="text-sm">
                  {p.status === "closed" ? "締め済み" : "締め前（暫定）"}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  );
}
