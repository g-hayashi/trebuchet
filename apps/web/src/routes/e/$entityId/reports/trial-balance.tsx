import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { CsvLink, PeriodPicker } from "@/features/reports/controls";
import { useReportRange } from "@/features/reports/periods";
import { BalancedBadge, ReportPage } from "@/features/reports/ReportPage";
import {
  Amount,
  amountCell,
  amountHeader,
  type ReportColumns,
  ReportTable,
} from "@/features/reports/ReportTable";
import { RangeSearch } from "@/features/reports/search";
import { type TrialBalance, trialBalanceQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/reports/trial-balance")({
  validateSearch: RangeSearch,
  component: TrialBalancePage,
});

type Row = TrialBalance["rows"][number];

const columns: ReportColumns<Row> = [
  { id: "code", header: "コード", accessorFn: (r) => r.code },
  { id: "name", header: "勘定科目", accessorFn: (r) => r.name },
  {
    id: "opening",
    header: amountHeader("期首残高"),
    accessorFn: (r) => r.opening,
    cell: amountCell(),
  },
  { id: "debit", header: amountHeader("借方"), accessorFn: (r) => r.debit, cell: amountCell() },
  { id: "credit", header: amountHeader("貸方"), accessorFn: (r) => r.credit, cell: amountCell() },
  {
    id: "closing",
    header: amountHeader("期末残高"),
    accessorFn: (r) => r.closing,
    cell: amountCell(),
  },
];

/** 残高試算表（FR-028）。残高は科目の通常の側を正とする */
function TrialBalancePage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { periods, range, error: periodsError } = useReportRange(entityId, search);
  const report = useQuery({
    ...trialBalanceQuery(entityId, range ?? { from: "", to: "" }),
    enabled: range !== undefined,
  });
  const data = report.data;

  return (
    <ReportPage
      entityId={entityId}
      title="残高試算表"
      range={range}
      error={periodsError ?? report.error}
      warnings={data?.warnings}
      controls={
        periods &&
        range && (
          <PeriodPicker
            periods={periods}
            range={range}
            onChange={(next) => navigate({ search: next })}
          />
        )
      }
      actions={range && <CsvLink entityId={entityId} kind="trial-balance" params={range} />}
    >
      {data && (
        <Card>
          <CardContent className="grid gap-2">
            <BalancedBadge balanced={data.balanced} />
            <ReportTable
              label="残高試算表"
              columns={columns}
              data={data.rows}
              getRowId={(r) => r.accountId}
              footer={
                <TableRow>
                  <TableCell />
                  <TableCell>合計</TableCell>
                  <TableCell />
                  <TableCell>
                    <Amount value={data.totals.debit} />
                  </TableCell>
                  <TableCell>
                    <Amount value={data.totals.credit} />
                  </TableCell>
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
