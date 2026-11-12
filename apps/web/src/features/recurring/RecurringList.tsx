import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loading } from "@/components/loading";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { recurringListQuery } from "./api";
import { dayLabel, periodLabel, STATUS_LABELS } from "./labels";

/** 定期仕訳の一覧（005/FR-023）。名前・予定日・期間・状態・次の予定日・登録済みの件数 */
export function RecurringList({ entityId }: { entityId: string }) {
  const { data, isPending, error } = useQuery(recurringListQuery(entityId));

  return (
    <div className="grid gap-4">
      <ApiErrorMessage error={error} />
      {isPending && <Loading />}
      {data &&
        (data.length === 0 ? (
          <p className="text-sm text-muted-foreground">定期仕訳はまだありません。</p>
        ) : (
          <Table aria-label="定期仕訳の一覧">
            <TableHeader>
              <TableRow>
                <TableHead>名前</TableHead>
                <TableHead>予定日</TableHead>
                <TableHead>期間</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>次の予定日</TableHead>
                <TableHead className="text-right">登録済み</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      to="/e/$entityId/recurring/$recurringId"
                      params={{ entityId, recurringId: r.id }}
                      className="text-primary underline underline-offset-4"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell>{dayLabel(r.dayOfMonth)}</TableCell>
                  <TableCell className="tabular-nums">
                    {periodLabel(r.startMonth, r.endMonth)}
                  </TableCell>
                  <TableCell>{STATUS_LABELS[r.status]}</TableCell>
                  <TableCell className="tabular-nums">{r.nextDate ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{`${r.postedCount} 件`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </div>
  );
}
