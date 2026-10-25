import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type BalanceSheet, balanceSheetQuery } from "@/features/reports/api";
import { AsOfPicker, CompareToggle, CsvLink } from "@/features/reports/controls";
import { periodOf, useReportAsOf } from "@/features/reports/periods";
import { BalancedBadge, ReportPage } from "@/features/reports/ReportPage";
import { type StatementLine, StatementTable } from "@/features/reports/StatementTable";
import { AsOfSearch } from "@/features/reports/search";
import { SECTION_LABELS } from "@/lib/accounts";

export const Route = createFileRoute("/e/$entityId/reports/balance-sheet")({
  validateSearch: AsOfSearch,
  component: BalanceSheetPage,
});

type Section = BalanceSheet["sections"][number];

const sumFigures = (a: Section["total"], b: Section["total"]) => ({
  amount: a.amount + b.amount,
  ...(a.previous !== undefined && { previous: a.previous + (b.previous ?? 0) }),
  ...(a.change !== undefined && { change: a.change + (b.change ?? 0) }),
});

const sectionLines = (s: Section): StatementLine[] => [
  { kind: "heading", key: s.section, name: SECTION_LABELS[s.section] },
  ...s.rows.map((r): StatementLine => ({ kind: "row", key: r.accountId, name: r.name, figure: r })),
];

/** 資産の部と、負債・純資産の部。純資産の計は当期利益を含む */
function statementLines(report: BalanceSheet) {
  const find = (section: Section["section"]) => report.sections.find((s) => s.section === section);
  const asset = find("BS_ASSET");
  const liability = find("BS_LIABILITY");
  const equity = find("BS_EQUITY");
  const assets: StatementLine[] = [
    ...(asset ? sectionLines(asset) : []),
    { kind: "grand", key: "total-assets", name: "資産合計", figure: report.totalAssets },
  ];
  const liabilitiesAndEquity: StatementLine[] = [
    ...(liability
      ? [
          ...sectionLines(liability),
          {
            kind: "total",
            key: "liability-total",
            name: "負債計",
            figure: liability.total,
          } as const,
        ]
      : []),
    ...(equity
      ? [
          ...sectionLines(equity),
          { kind: "row", key: "net-income", name: "当期利益", figure: report.netIncome } as const,
          {
            kind: "total",
            key: "equity-total",
            name: "純資産計",
            figure: sumFigures(equity.total, report.netIncome),
          } as const,
        ]
      : []),
    {
      kind: "grand",
      key: "total-liabilities-and-equity",
      name: "負債・純資産合計",
      figure: report.totalLiabilitiesAndEquity,
    },
  ];
  return { assets, liabilitiesAndEquity };
}

/** 貸借対照表（FR-029, FR-030） */
function BalanceSheetPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { periods, asOf, error: periodsError } = useReportAsOf(entityId, search.asOf);
  const params =
    asOf === undefined
      ? undefined
      : { asOf, ...(search.compare !== undefined && { compare: search.compare }) };
  const report = useQuery({
    ...balanceSheetQuery(entityId, params ?? { asOf: "" }),
    enabled: params !== undefined,
  });
  const data = report.data;
  const period = periods && asOf ? periodOf(periods, asOf) : undefined;
  const lines = data && statementLines(data);
  const compare = data?.previousAsOf != null;

  return (
    <ReportPage
      entityId={entityId}
      title="貸借対照表"
      range={period && asOf ? { from: period.startDate, to: asOf } : undefined}
      error={periodsError ?? report.error}
      warnings={data?.warnings}
      controls={
        periods &&
        asOf && (
          <div className="flex flex-wrap items-end gap-6">
            <AsOfPicker
              periods={periods}
              asOf={asOf}
              onChange={(next) => navigate({ search: (prev) => ({ ...prev, asOf: next }) })}
            />
            <CompareToggle
              checked={search.compare !== undefined}
              onChange={(checked) =>
                navigate({
                  search: (prev) => ({ ...prev, compare: checked ? "previous-year" : undefined }),
                })
              }
            />
          </div>
        )
      }
      actions={params && <CsvLink entityId={entityId} kind="balance-sheet" params={params} />}
    >
      {data && lines && (
        <>
          <div className="flex flex-wrap gap-4">
            <BalancedBadge balanced={data.balanced} />
            {data.previousAsOf && (
              <p className="text-sm text-muted-foreground">前年: {data.previousAsOf} 現在</p>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>資産の部</CardTitle>
              </CardHeader>
              <CardContent>
                <StatementTable label="資産の部" compare={compare} lines={lines.assets} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>負債・純資産の部</CardTitle>
              </CardHeader>
              <CardContent>
                <StatementTable
                  label="負債・純資産の部"
                  compare={compare}
                  lines={lines.liabilitiesAndEquity}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </ReportPage>
  );
}
