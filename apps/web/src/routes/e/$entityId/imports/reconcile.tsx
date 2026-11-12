import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reconcileFreeeQuery } from "@/features/imports/api";
import { FilePicker } from "@/features/imports/FilePicker";
import { ReconcileTable } from "@/features/imports/ReconcileTable";
import { fiscalPeriodsQuery } from "@/features/periods/api";

export const Route = createFileRoute("/e/$entityId/imports/reconcile")({
  component: ReconcilePage,
});

/** 元帳との照合（002/US3）。年度と freee の総勘定元帳を選ぶと、帳簿の科目ごとに並べて比べる */
function ReconcilePage() {
  const { entityId } = Route.useParams();
  const yearId = useId();
  const [year, setYear] = useState<string>();
  const [file, setFile] = useState<File>();
  const [journal, setJournal] = useState<File>();
  const [fileKey, setFileKey] = useState(0);
  const periods = useQuery(fiscalPeriodsQuery(entityId));
  const result = useQuery(reconcileFreeeQuery(entityId, year, file, fileKey, journal));

  const data = result.isError ? undefined : result.data;
  const mismatched = data?.rows.filter((r) => !r.matched).length ?? 0;

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">元帳と照合</h1>
        <Link
          to="/e/$entityId/imports"
          params={{ entityId }}
          className="text-sm underline-offset-4 hover:underline"
        >
          取込の履歴へ
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>freee の総勘定元帳</CardTitle>
          <CardDescription>
            年度と、freee から書き出したその年度の総勘定元帳の CSV
            を選ぶと、帳簿の科目ごとに期首残高・借方合計・貸方合計・期末残高を比べます。帳簿は変わりません。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid max-w-48 gap-2">
            <Label htmlFor={yearId}>年度</Label>
            <NativeSelect
              id={yearId}
              value={year ?? ""}
              onChange={(e) => setYear(e.currentTarget.value || undefined)}
            >
              <option value="">選んでください</option>
              {periods.data?.map((p) => (
                <option key={p.fiscalYear} value={String(p.fiscalYear)}>
                  {p.fiscalYear}
                </option>
              ))}
            </NativeSelect>
          </div>
          <FilePicker
            label="総勘定元帳のファイル"
            onChange={(next) => {
              setFile(next);
              setFileKey((k) => k + 1);
            }}
          />
          <FilePicker
            label="仕訳帳のファイル（任意）"
            description="同じ年度の仕訳帳も選ぶと、不一致の原因の候補に、取込の対象外にした仕訳・取り込めない仕訳が加わります。"
            onChange={(next) => {
              setJournal(next);
              setFileKey((k) => k + 1);
            }}
          />
          {result.isFetching && <p className="text-sm text-muted-foreground">照合しています…</p>}
          <ApiErrorMessage error={periods.error ?? result.error} />
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>{year}年度の照合の結果</CardTitle>
            <CardDescription>
              freee
              の複数の科目を1つの科目に対応づけた場合は、合計で比べます。「損益」は比べません。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div
              role="status"
              className={
                data.allMatched
                  ? "rounded-md border border-emerald-600/50 px-4 py-3 text-sm font-medium"
                  : "grid gap-1 rounded-md border border-destructive/50 px-4 py-3 text-sm"
              }
            >
              {data.allMatched ? (
                <p>すべての科目が一致しました。</p>
              ) : (
                <>
                  {mismatched > 0 && (
                    <p className="font-medium text-destructive">
                      一致しない科目が{mismatched}
                      件あります。行を開くと、差額と原因の候補を確かめられます。
                    </p>
                  )}
                  {data.unmapped.length > 0 && (
                    <p>
                      対応が決まっていない freee の科目があり、比べていません:{" "}
                      {data.unmapped.join("、")}。
                      <Link
                        to="/e/$entityId/imports/new"
                        params={{ entityId }}
                        className="underline underline-offset-2"
                      >
                        新しい取込
                      </Link>
                      の対応表で対応づけてください。
                    </p>
                  )}
                </>
              )}
            </div>
            <ReconcileTable rows={data.rows} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
