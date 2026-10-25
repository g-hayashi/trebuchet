import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { WorkHoursQuery } from "@trebuchet/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { defaultTargetMonth } from "@/features/invoicing/months";
import { WorkHoursTable } from "@/features/invoicing/WorkHoursTable";

export const Route = createFileRoute("/e/$entityId/work-hours")({
  validateSearch: WorkHoursQuery.partial(),
  component: WorkHoursPage,
});

function WorkHoursPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const month = search.month ?? defaultTargetMonth();

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">工数の入力</h1>
        <Link
          to="/e/$entityId/invoices"
          params={{ entityId }}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          請求書の一覧へ
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>対象月の工数</CardTitle>
          <CardDescription>
            時間単価型の取引先ごとに、その月に働いた時間を 0.5 時間単位で入力します。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid max-w-48 gap-2">
            <Label htmlFor="work-hours-month">対象月</Label>
            <Input
              id="work-hours-month"
              type="month"
              value={month}
              onChange={(e) => {
                const next = WorkHoursQuery.safeParse({ month: e.target.value });
                if (next.success) void navigate({ search: { month: next.data.month } });
              }}
            />
          </div>
          <WorkHoursTable key={month} entityId={entityId} month={month} />
        </CardContent>
      </Card>
    </main>
  );
}
