import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  type Account,
  accountsQuery,
  type SubAccount,
  subAccountsQuery,
} from "@/features/accounts/api";
import { type GeneralLedger, generalLedgerQuery } from "@/features/reports/api";
import { CsvLink, PeriodPicker } from "@/features/reports/controls";
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
import { LedgerSearch } from "@/features/reports/search";
import { groupAccountsBySection } from "@/lib/accounts";

export const Route = createFileRoute("/e/$entityId/reports/general-ledger")({
  validateSearch: LedgerSearch,
  component: GeneralLedgerPage,
});

type Entry = GeneralLedger["entries"][number];

const columns: ReportColumns<Entry> = [
  { id: "date", header: "日付", accessorFn: (e) => e.date },
  {
    id: "journalNo",
    header: "No.",
    accessorFn: (e) => e.journalNo,
    cell: ({ row }) => (
      <JournalLink journalId={row.original.journalId} journalNo={row.original.journalNo} />
    ),
  },
  { id: "counterpart", header: "相手科目", accessorFn: (e) => e.counterpart },
  { id: "description", header: "摘要", accessorFn: (e) => e.description ?? "" },
  { id: "debit", header: amountHeader("借方"), accessorFn: (e) => e.debit, cell: amountCell(true) },
  {
    id: "credit",
    header: amountHeader("貸方"),
    accessorFn: (e) => e.credit,
    cell: amountCell(true),
  },
  { id: "balance", header: amountHeader("残高"), accessorFn: (e) => e.balance, cell: amountCell() },
];

/** 総勘定元帳（001/FR-027）。科目（と補助科目）ごとに、前期繰越から残高の推移を表示する */
function GeneralLedgerPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { periods, range, error: periodsError } = useReportRange(entityId, search);
  const accounts = useQuery(accountsQuery(entityId));
  const { accountId, subAccountId } = search;
  const subAccounts = useQuery({
    ...subAccountsQuery(entityId, accountId ?? ""),
    enabled: accountId !== undefined,
  });
  const params =
    range && accountId !== undefined
      ? { ...range, accountId, ...(subAccountId !== undefined && { subAccountId }) }
      : undefined;
  const report = useQuery({
    ...generalLedgerQuery(entityId, params ?? { from: "", to: "", accountId: "" }),
    enabled: params !== undefined,
  });
  const data = report.data;

  return (
    <ReportPage
      entityId={entityId}
      title="総勘定元帳"
      range={range}
      error={periodsError ?? accounts.error ?? subAccounts.error ?? report.error}
      warnings={data?.warnings}
      controls={
        <div className="flex flex-wrap items-end gap-6">
          {periods && range && (
            <PeriodPicker
              periods={periods}
              range={range}
              onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
            />
          )}
          {accounts.data && (
            <AccountSelect
              accounts={accounts.data}
              subAccounts={accountId !== undefined ? subAccounts.data : undefined}
              accountId={accountId}
              subAccountId={subAccountId}
              onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
            />
          )}
        </div>
      }
      actions={params && <CsvLink entityId={entityId} kind="general-ledger" params={params} />}
    >
      {accountId === undefined && (
        <p className="text-sm text-muted-foreground">勘定科目を選んでください</p>
      )}
      {data && (
        <Card>
          <CardContent>
            <ReportTable
              label={`総勘定元帳（${data.account.name}${data.subAccount ? `・${data.subAccount.name}` : ""}）`}
              columns={columns}
              data={data.entries}
              getRowId={(e) => `${e.journalId}-${e.lineNo}`}
              before={
                <TableRow>
                  <TableCell>{data.from}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell>前期繰越</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell>
                    <Amount value={data.broughtForward} />
                  </TableCell>
                </TableRow>
              }
              footer={
                <TableRow>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                  <TableCell>合計</TableCell>
                  <TableCell>
                    <Amount value={data.totals.debit} />
                  </TableCell>
                  <TableCell>
                    <Amount value={data.totals.credit} />
                  </TableCell>
                  <TableCell>
                    <Amount value={data.closing} />
                  </TableCell>
                </TableRow>
              }
            />
          </CardContent>
        </Card>
      )}
    </ReportPage>
  );
}

type AccountSelection = { accountId: string | undefined; subAccountId: string | undefined };

/** 勘定科目と補助科目の選択。科目を変えると補助科目の指定を外す */
function AccountSelect({
  accounts,
  subAccounts,
  accountId,
  subAccountId,
  onChange,
}: AccountSelection & {
  accounts: readonly Account[];
  subAccounts: readonly SubAccount[] | undefined;
  onChange: (next: AccountSelection) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-account`}>勘定科目</Label>
        <NativeSelect
          id={`${id}-account`}
          className="w-48"
          value={accountId ?? ""}
          onChange={(e) =>
            onChange({ accountId: e.target.value || undefined, subAccountId: undefined })
          }
        >
          <option value="">選んでください</option>
          {groupAccountsBySection(accounts).map((group) => (
            <optgroup key={group.section} label={group.label}>
              {group.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </div>
      {subAccounts && subAccounts.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-sub-account`}>補助科目</Label>
          <NativeSelect
            id={`${id}-sub-account`}
            className="w-40"
            value={subAccountId ?? ""}
            onChange={(e) => onChange({ accountId, subAccountId: e.target.value || undefined })}
          >
            <option value="">すべて</option>
            {subAccounts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </div>
  );
}
