import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { type ProfitAndLoss, profitAndLossQuery } from "@/features/reports/api";
import {
  CompareToggle,
  CsvLink,
  PeriodPicker,
  PreviousYearNotice,
} from "@/features/reports/controls";
import { useReportRange } from "@/features/reports/periods";
import { ReportPage } from "@/features/reports/ReportPage";
import { type StatementLine, StatementTable } from "@/features/reports/StatementTable";
import { CompareSearch, RangeSearch } from "@/features/reports/search";
import { SECTION_LABELS } from "@/lib/accounts";

export const Route = createFileRoute("/e/$entityId/reports/profit-and-loss")({
  validateSearch: RangeSearch.extend(CompareSearch.shape),
  component: ProfitAndLossPage,
});

/** 区分ごとの科目と計。売上原価の後に売上総利益、最後に差引金額（当期の利益） */
function statementLines(report: ProfitAndLoss): StatementLine[] {
  return [
    ...report.sections.flatMap((s): StatementLine[] => {
      const label = SECTION_LABELS[s.section];
      return [
        { kind: "heading", key: s.section, name: label },
        ...s.rows.map(
          (r): StatementLine => ({
            kind: "row",
            key: r.accountId,
            name: r.name,
            figure: r,
            accountId: r.accountId,
          }),
        ),
        { kind: "total", key: `${s.section}-total`, name: `${label}計`, figure: s.total },
        ...(s.section === "PL_COGS"
          ? [
              {
                kind: "total",
                key: "gross-profit",
                name: "売上総利益",
                figure: report.grossProfit,
              } as const,
            ]
          : []),
      ];
    }),
    { kind: "grand", key: "net-income", name: "差引金額", figure: report.netIncome },
  ];
}

/** 損益計算書（001/FR-029, 001/FR-030） */
function ProfitAndLossPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { periods, range, error: periodsError } = useReportRange(entityId, search);
  const params = range && {
    ...range,
    ...(search.compare !== undefined && { compare: search.compare }),
  };
  const report = useQuery({
    ...profitAndLossQuery(entityId, params ?? { from: "", to: "" }),
    enabled: params !== undefined,
  });
  const data = report.data;
  const compare = search.compare !== undefined;

  return (
    <ReportPage
      entityId={entityId}
      title="損益計算書"
      range={range}
      error={periodsError ?? report.error}
      warnings={data?.warnings}
      controls={
        periods &&
        range && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-6">
              <PeriodPicker
                periods={periods}
                range={range}
                onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
              />
              <CompareToggle
                checked={compare}
                onChange={(checked) =>
                  navigate({
                    search: (prev) => ({ ...prev, compare: checked ? "previous-year" : undefined }),
                  })
                }
              />
            </div>
            {compare && data?.previousHasData === false && (
              <PreviousYearNotice
                entityId={entityId}
                reason={`前年の同じ期間（${data.previous?.from} 〜 ${data.previous?.to}）に仕訳がありません。`}
              />
            )}
          </div>
        )
      }
      actions={params && <CsvLink entityId={entityId} kind="profit-and-loss" params={params} />}
    >
      {data && range && (
        <Card>
          <CardContent className="grid gap-2">
            {data.previous && (
              <p className="text-sm text-muted-foreground">
                前年: {data.previous.from} 〜 {data.previous.to}
              </p>
            )}
            <StatementTable
              label="損益計算書"
              compare={data.previous !== null}
              lines={statementLines(data)}
              ledger={{ entityId, ...range }}
            />
          </CardContent>
        </Card>
      )}
    </ReportPage>
  );
}
