import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { type JournalBook, journalBookQuery } from "@/features/reports/api";
import { CsvLink, JournalBookSortControls, PeriodPicker } from "@/features/reports/controls";
import { JournalLink } from "@/features/reports/JournalLink";
import { useReportRange } from "@/features/reports/periods";
import { ReportPage } from "@/features/reports/ReportPage";
import {
  Amount,
  amountCell,
  amountHeader,
  type ReportColumns,
  ReportTable,
} from "@/features/reports/ReportTable";
import { JournalBookSearch } from "@/features/reports/search";

export const Route = createFileRoute("/e/$entityId/reports/journal-book")({
  validateSearch: JournalBookSearch,
  component: JournalBookPage,
});

type Entry = JournalBook["entries"][number];
type Line = Entry["lines"][number];
/** 明細 1 行が表の 1 行。仕訳の最初の行に日付・仕訳番号・メモを出す */
type Row = { entry: Entry; line: Line; first: boolean };

const accountLabel = (line: Line) =>
  line.subAccountName ? `${line.accountName}（${line.subAccountName}）` : line.accountName;

const columns: ReportColumns<Row> = [
  { id: "date", header: "日付", accessorFn: (r) => (r.first ? r.entry.date : "") },
  {
    id: "journalNo",
    header: "No.",
    accessorFn: (r) => r.entry.journalNo,
    cell: ({ row: { original: r } }) =>
      r.first ? <JournalLink journalId={r.entry.journalId} journalNo={r.entry.journalNo} /> : null,
  },
  {
    id: "debitAccount",
    header: "借方科目",
    accessorFn: (r) => (r.line.side === "debit" ? accountLabel(r.line) : ""),
  },
  {
    id: "debit",
    header: amountHeader("借方金額"),
    accessorFn: (r) => (r.line.side === "debit" ? r.line.amount : 0),
    cell: amountCell(true),
  },
  {
    id: "creditAccount",
    header: "貸方科目",
    accessorFn: (r) => (r.line.side === "credit" ? accountLabel(r.line) : ""),
  },
  {
    id: "credit",
    header: amountHeader("貸方金額"),
    accessorFn: (r) => (r.line.side === "credit" ? r.line.amount : 0),
    cell: amountCell(true),
  },
  { id: "partner", header: "取引先", accessorFn: (r) => r.line.partnerName ?? "" },
  {
    id: "description",
    header: "摘要",
    accessorFn: (r) =>
      [r.first ? r.entry.memo : null, r.line.description].filter((s) => s).join(" "),
  },
];

const toRows = (entries: readonly Entry[]): Row[] =>
  entries.flatMap((entry) => entry.lines.map((line, i) => ({ entry, line, first: i === 0 })));

/** 仕訳帳（FR-026, FR-038）。既定は日付・仕訳番号の昇順。取引日・登録日の昇順・降順に並べ替えられる */
function JournalBookPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { periods, range, error: periodsError } = useReportRange(entityId, search);
  const sort = search.sort ?? "date";
  const order = search.order ?? "asc";
  const params = range && { ...range, sort, order };
  const report = useQuery({
    ...journalBookQuery(entityId, params ?? { from: "", to: "", sort, order }),
    enabled: params !== undefined,
  });
  const data = report.data;

  return (
    <ReportPage
      entityId={entityId}
      title="仕訳帳"
      range={range}
      error={periodsError ?? report.error}
      warnings={data?.warnings}
      controls={
        periods &&
        range && (
          <div className="flex flex-wrap items-end gap-6">
            <PeriodPicker
              periods={periods}
              range={range}
              onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
            />
            <JournalBookSortControls
              sort={sort}
              order={order}
              onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...range, ...next }) })}
            />
          </div>
        )
      }
      actions={params && <CsvLink entityId={entityId} kind="journal-book" params={params} />}
    >
      {data && data.entries.length === 0 && (
        <p className="text-sm text-muted-foreground">この期間の仕訳はありません。</p>
      )}
      {data && data.entries.length > 0 && (
        <Card>
          <CardContent>
            <ReportTable
              label="仕訳帳"
              columns={columns}
              data={toRows(data.entries)}
              getRowId={(r) => `${r.entry.journalId}-${r.line.lineNo}`}
              rowClassName={(r) => (r.first ? "border-t-2" : undefined)}
              footer={
                <TableRow>
                  <TableCell />
                  <TableCell />
                  <TableCell>合計</TableCell>
                  <TableCell>
                    <Amount value={data.totals.debit} />
                  </TableCell>
                  <TableCell />
                  <TableCell>
                    <Amount value={data.totals.credit} />
                  </TableCell>
                  <TableCell />
                  <TableCell />
                </TableRow>
              }
            />
          </CardContent>
        </Card>
      )}
    </ReportPage>
  );
}
