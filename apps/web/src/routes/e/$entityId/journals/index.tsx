import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
import { formatYen } from "@/lib/format";
import { accountsQuery, type Journal, journalsQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/e/$entityId/journals/")({
  component: JournalsPage,
});

function JournalsPage() {
  const { entityId } = Route.useParams();
  const journals = useQuery(journalsQuery(entityId));
  const accounts = useQuery(accountsQuery(entityId));
  const error = journals.error ?? accounts.error;
  const accountNames = new Map(accounts.data?.map((a) => [a.id, a.name]));

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">仕訳</h1>
        <Link
          to="/e/$entityId/journals/new"
          params={{ entityId }}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          仕訳を入力
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近の仕訳（新しい順）</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {(journals.isPending || accounts.isPending) && !error && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {journals.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              仕訳がありません。「仕訳を入力」から登録してください。
            </p>
          )}
          {journals.data && journals.data.length > 0 && accounts.data && (
            <Table aria-label="仕訳の一覧">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">日付</TableHead>
                  <TableHead className="w-16 text-right">No.</TableHead>
                  <TableHead>借方</TableHead>
                  <TableHead>貸方</TableHead>
                  <TableHead>摘要・メモ</TableHead>
                  <TableHead className="w-20">状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journals.data.map((j) => (
                  <JournalRow key={j.id} journal={j} accountNames={accountNames} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function JournalRow({
  journal,
  accountNames,
}: {
  journal: Journal;
  accountNames: Map<string, string>;
}) {
  const voided = journal.status === "voided";
  const sideLines = (side: "debit" | "credit") =>
    journal.lines
      .filter((l) => l.side === side)
      .map((l) => (
        <div key={l.id} className="flex justify-between gap-4">
          <span>{accountNames.get(l.accountId) ?? "（不明な科目）"}</span>
          <span className="tabular-nums">{formatYen(l.amount)}</span>
        </div>
      ));
  const notes = [
    ...(journal.memo === null ? [] : [{ key: "memo", text: journal.memo }]),
    ...journal.lines.flatMap((l) =>
      l.description === null ? [] : [{ key: l.id, text: l.description }],
    ),
  ];

  return (
    <TableRow className={cn("align-top", voided && "text-muted-foreground")}>
      <TableCell className="tabular-nums">{journal.date}</TableCell>
      <TableCell className="text-right tabular-nums">{journal.journalNo}</TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("debit")}</TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("credit")}</TableCell>
      <TableCell>
        {notes.map((n) => (
          <div key={n.key}>{n.text}</div>
        ))}
      </TableCell>
      <TableCell>{voided ? "取消済み" : ""}</TableCell>
    </TableRow>
  );
}
