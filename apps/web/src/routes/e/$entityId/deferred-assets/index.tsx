import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountsQuery } from "@/features/accounts/api";
import { AdjustmentPanel } from "@/features/blue-return/AdjustmentPanel";
import { adjustmentsQuery } from "@/features/blue-return/api";
import {
  AmortizationDecision,
  decisionLabel,
} from "@/features/deferred-assets/AmortizationDecision";
import { deferredAssetsQuery } from "@/features/deferred-assets/api";
import { DeferredAssetForm } from "@/features/deferred-assets/DeferredAssetForm";
import { thisYear } from "@/lib/dates";
import { formatYen } from "@/lib/format";

/** 年分は暦年（個人）。不正な値は捨てて、今年にする */
const Search = z.object({ year: z.number().int().min(1900).max(9999).optional().catch(undefined) });

export const Route = createFileRoute("/e/$entityId/deferred-assets/")({
  validateSearch: Search,
  component: DeferredAssetsPage,
});

/**
 * 開業費の画面（009 US3。以前は固定資産台帳の下の節だった。011 FR-046）。
 * 開業費の登録・編集と、年分ごとの償却額の決定、決算整理の仕訳の案。API・規則（009）は変えない
 */
function DeferredAssetsPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const year = search.year ?? thisYear();
  const [yearText, setYearText] = useState(String(year));
  // 編集の対象と成功の知らせ。保存すると入力欄を作り直すので、ここで持つ
  const [editingDeferredId, setEditingDeferredId] = useState<string>();
  const [deferredNotice, setDeferredNotice] = useState("");

  const deferredAssets = useQuery(deferredAssetsQuery(entityId, year));
  const accounts = useQuery(accountsQuery(entityId));
  const adjustments = useQuery(adjustmentsQuery(entityId, String(year)));
  const deferredRows = deferredAssets.data ?? [];
  const editingDeferred = deferredRows.find((d) => d.id === editingDeferredId);

  const changeYear = (text: string) => {
    setYearText(text);
    if (/^\d{4}$/.test(text)) navigate({ search: { year: Number(text) } });
  };

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">開業費</h1>
      <div className="grid max-w-40 gap-1">
        <label htmlFor="deferred-year" className="text-sm font-medium">
          年分
        </label>
        <Input
          id="deferred-year"
          inputMode="numeric"
          autoComplete="off"
          value={yearText}
          onChange={(e) => changeYear(e.target.value)}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>開業費（{year}年分）</CardTitle>
          <CardDescription>
            開業費は固定資産とは別に、年分ごとに償却額を決めます。上限は期首の未償却残高、目安は 60
            か月の均等償却です。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={deferredAssets.error} />
          {deferredAssets.data && deferredRows.length === 0 && (
            <p className="text-sm text-muted-foreground">開業費はまだ登録されていません。</p>
          )}
          {deferredRows.length > 0 && (
            <Table aria-label="開業費の一覧">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>開業日</TableHead>
                  <TableHead className="text-right">総額</TableHead>
                  <TableHead className="text-right">本年の上限</TableHead>
                  <TableHead className="text-right">本年の目安</TableHead>
                  <TableHead>本年の決定</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {deferredRows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.name}</TableCell>
                    <TableCell>{d.openedOn}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatYen(d.totalAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.amortization ? formatYen(d.amortization.openingBalance) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.amortization ? formatYen(d.amortization.target) : ""}
                    </TableCell>
                    <TableCell>{decisionLabel(d.amortization)}</TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDeferredNotice("");
                          setEditingDeferredId(d.id);
                        }}
                      >
                        {`${d.name}を編集`}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {deferredRows.map((d) => (
            <AmortizationDecision
              key={`${d.id}-${year}`}
              entityId={entityId}
              year={year}
              asset={d}
            />
          ))}
        </CardContent>
      </Card>

      {accounts.data && (
        <DeferredAssetForm
          // 編集する開業費を切り替えたら入力欄を作り直す
          key={`deferred-${editingDeferred?.id ?? "new"}`}
          entityId={entityId}
          accounts={accounts.data}
          editing={editingDeferred}
          onDone={() => setEditingDeferredId(undefined)}
          notice={deferredNotice}
          onSaved={setDeferredNotice}
        />
      )}

      <ApiErrorMessage error={adjustments.error ?? accounts.error} />
      {adjustments.data && accounts.data && (
        <AdjustmentPanel
          entityId={entityId}
          year={String(year)}
          proposals={adjustments.data.filter((p) => p.kind === "deferred_amortization")}
          accounts={accounts.data}
          deferredAssets={deferredRows}
        />
      )}
    </main>
  );
}
