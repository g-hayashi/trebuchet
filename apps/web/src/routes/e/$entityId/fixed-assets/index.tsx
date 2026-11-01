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
import { formatRatioAsPercent } from "@/features/blue-return/ratio";
import { fixedAssetsQuery } from "@/features/fixed-assets/api";
import { DisposeDialog } from "@/features/fixed-assets/DisposeDialog";
import { FixedAssetForm } from "@/features/fixed-assets/FixedAssetForm";
import { depreciationErrorText, METHOD_SHORT_LABELS } from "@/features/fixed-assets/methods";
import { thisYear } from "@/lib/dates";
import { formatYen } from "@/lib/format";

/** 除却の種類（定額法の資産だけが持つ）の表示。ないときは何も足さない */
const DISPOSAL_KIND_SUFFIX: Record<string, string> = { scrap: "（廃棄）", sale: "（売却）" };

/** 年分は暦年（個人）。不正な値は捨てて、今年にする */
const Search = z.object({ year: z.number().int().min(1900).max(9999).optional().catch(undefined) });

export const Route = createFileRoute("/e/$entityId/fixed-assets/")({
  validateSearch: Search,
  component: FixedAssetsPage,
});

/** 固定資産台帳（US3、FR-018〜023）。登録・編集・除却と、年分ごとの償却の計算、決算整理の仕訳の案 */
function FixedAssetsPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const year = search.year ?? thisYear();
  const [yearText, setYearText] = useState(String(year));
  const [editingId, setEditingId] = useState<string>();
  const [disposingId, setDisposingId] = useState<string>();
  // 登録・更新の成功の知らせ。保存すると入力欄を作り直すので、ここで持つ
  const [notice, setNotice] = useState("");

  const assets = useQuery(fixedAssetsQuery(entityId, year));
  const accounts = useQuery(accountsQuery(entityId));
  const adjustments = useQuery(adjustmentsQuery(entityId, String(year)));
  const rows = assets.data ?? [];
  const editing = rows.find((a) => a.id === editingId);
  const disposing = rows.find((a) => a.id === disposingId);

  const changeYear = (text: string) => {
    setYearText(text);
    if (/^\d{4}$/.test(text)) navigate({ search: { year: Number(text) } });
  };

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">固定資産台帳</h1>
      <Card>
        <CardHeader>
          <CardTitle>台帳（{year}年分）</CardTitle>
          <CardDescription>
            償却費・必要経費算入額・未償却残高は、年分を変えると計算し直します。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid max-w-40 gap-1">
            <label htmlFor="asset-year" className="text-sm font-medium">
              年分
            </label>
            <Input
              id="asset-year"
              inputMode="numeric"
              autoComplete="off"
              value={yearText}
              onChange={(e) => changeYear(e.target.value)}
            />
          </div>
          <ApiErrorMessage error={assets.error} />
          {assets.isPending && !assets.error && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {assets.data && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">固定資産はまだ登録されていません。</p>
          )}
          {rows.length > 0 && (
            <Table aria-label="固定資産台帳">
              <TableHeader>
                <TableRow>
                  <TableHead>資産名</TableHead>
                  <TableHead>数量</TableHead>
                  <TableHead>取得年月日</TableHead>
                  <TableHead className="text-right">取得価額</TableHead>
                  <TableHead>償却方法</TableHead>
                  <TableHead className="text-right">事業専用割合</TableHead>
                  <TableHead className="text-right">本年分の償却費</TableHead>
                  <TableHead className="text-right">必要経費算入額</TableHead>
                  <TableHead className="text-right">未償却残高</TableHead>
                  <TableHead>状態</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.name}</TableCell>
                    <TableCell>{a.quantity ?? ""}</TableCell>
                    <TableCell>{a.acquiredOn}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatYen(a.acquisitionCost)}
                    </TableCell>
                    <TableCell>{METHOD_SHORT_LABELS[a.method]}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRatioAsPercent(a.businessRatio)}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.depreciation ? formatYen(a.depreciation.total) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.depreciation ? formatYen(a.depreciation.deductible) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.depreciation ? formatYen(a.depreciation.closingBookValue) : ""}
                    </TableCell>
                    <TableCell>
                      {a.disposedOn
                        ? `除却 ${a.disposedOn}${DISPOSAL_KIND_SUFFIX[a.disposalKind ?? ""] ?? ""}`
                        : "使用中"}
                      {a.depreciationError && (
                        <span className="block text-destructive">
                          償却を計算できません（{depreciationErrorText(a.depreciationError.code)}）
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setNotice("");
                          setEditingId(a.id);
                        }}
                      >
                        {`${a.name}を編集`}
                      </Button>
                      {a.disposedOn === null && (
                        <Button variant="outline" size="sm" onClick={() => setDisposingId(a.id)}>
                          {`${a.name}を除却`}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {accounts.data && (
        <FixedAssetForm
          // 編集する資産を切り替えたら入力欄を作り直す
          key={editing?.id ?? "new"}
          entityId={entityId}
          accounts={accounts.data}
          editing={editing}
          onDone={() => setEditingId(undefined)}
          notice={notice}
          onSaved={setNotice}
        />
      )}

      <ApiErrorMessage error={adjustments.error ?? accounts.error} />
      {adjustments.data && accounts.data && (
        <AdjustmentPanel
          entityId={entityId}
          year={String(year)}
          proposals={adjustments.data.filter((p) => p.kind === "depreciation")}
          accounts={accounts.data}
          assets={rows}
        />
      )}

      <DisposeDialog
        entityId={entityId}
        asset={disposing}
        onClose={() => setDisposingId(undefined)}
      />
    </main>
  );
}
