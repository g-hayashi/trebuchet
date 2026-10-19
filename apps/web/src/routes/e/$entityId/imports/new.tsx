import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ImportBatch, ImportOptions, ImportPreview, TaxCategoryCode } from "@trebuchet/schema";
import { useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { commitImport, importPreviewQuery } from "@/features/imports/api";
import { FilePicker } from "@/features/imports/FilePicker";
import {
  type AccountEdits,
  type AccountTarget,
  MappingEditor,
  type TaxEdits,
} from "@/features/imports/MappingEditor";
import { type ItemSelection, PlanItemsTable } from "@/features/imports/PlanItemsTable";
import { PreviewSummary } from "@/features/imports/PreviewSummary";
import { YearSelector } from "@/features/imports/YearSelector";
import { ApiError } from "@/lib/api";
import { accountsQuery, queryKeys, taxCategoriesQuery } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/imports/new")({
  component: NewImportPage,
});

const NO_SELECTION: ItemSelection = { include: [], exclude: [] };

/** 選択から確定・プレビューの options を作る。指定のない項目は送らない */
function buildOptions(fiscalYears: number[] | undefined, selection: ItemSelection): ImportOptions {
  return {
    ...(fiscalYears !== undefined && { fiscalYears }),
    ...(selection.include.length > 0 && { include: [...selection.include] }),
    ...(selection.exclude.length > 0 && { exclude: [...selection.exclude] }),
  };
}

/**
 * 新しい取込（US1）。ファイルを選ぶとプレビューを作り、対応表・年度・個別の指定を変えるたびに
 * プレビューを作り直す。「取り込む」で、見ているプレビューの件数を添えて確定する
 */
function NewImportPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const statusId = useId();
  const [file, setFile] = useState<File>();
  const [fileKey, setFileKey] = useState(0);
  const [fiscalYears, setFiscalYears] = useState<number[]>();
  const [selection, setSelection] = useState<ItemSelection>(NO_SELECTION);
  const [accountEdits, setAccountEdits] = useState<AccountEdits>({});
  const [taxEdits, setTaxEdits] = useState<TaxEdits>({});
  const [result, setResult] = useState<ImportBatch>();

  const options = buildOptions(fiscalYears, selection);
  const previewOptions = importPreviewQuery(entityId, file, fileKey, options);
  const preview = useQuery({
    ...previewOptions,
    enabled: file !== undefined && result === undefined,
    // 同じファイルで条件を変えている間は、前のプレビューを表示したまま作り直す
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === fileKey ? previous : undefined,
  });
  const accounts = useQuery(accountsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));

  const commit = useMutation({
    mutationFn: ({ file, data }: { file: File; data: ImportPreview }) =>
      commitImport(entityId, file, options, {
        fileSha256: data.file.sha256,
        countNew: data.counts.new,
      }),
    onSuccess: async ({ batch }) => {
      setResult(batch);
      await queryClient.invalidateQueries({ queryKey: queryKeys.entity(entityId) });
    },
    onError: (error) => {
      // 確定の前に帳簿が変わった。サーバーが作り直したプレビューに差し替える
      if (error instanceof ApiError && error.code === "IMPORT_PLAN_CHANGED") {
        const changed = error.details?.preview as ImportPreview | undefined;
        if (changed) queryClient.setQueryData(previewOptions.queryKey, changed);
      }
    },
  });

  const chooseFile = (next: File | undefined) => {
    setFile(next);
    setFileKey((k) => k + 1);
    setFiscalYears(undefined);
    setSelection(NO_SELECTION);
    setAccountEdits({});
    setTaxEdits({});
    setResult(undefined);
    commit.reset();
  };

  const onAccountEdit = useCallback(
    (sourceName: string, target: AccountTarget) =>
      setAccountEdits((edits) => ({ ...edits, [sourceName]: target })),
    [],
  );
  const onTaxEdit = useCallback(
    (sourceName: string, taxCategory: TaxCategoryCode | undefined) =>
      setTaxEdits((edits) => ({ ...edits, [sourceName]: taxCategory })),
    [],
  );
  const onSaved = async () => {
    await queryClient.invalidateQueries({ queryKey: previewOptions.queryKey });
    setAccountEdits({});
    setTaxEdits({});
  };

  const data = result === undefined && !preview.isError ? preview.data : undefined;
  const dirty = Object.keys(accountEdits).length > 0 || Object.keys(taxEdits).length > 0;
  const unmapped = data
    ? [...data.mappings.accounts, ...data.mappings.taxes].filter((m) => m.status === "unmapped")
        .length
    : 0;
  const busy = preview.isFetching || commit.isPending;
  const status = !data
    ? ""
    : dirty
      ? "対応表の変更を保存してから取り込んでください。"
      : unmapped > 0
        ? `対応が決まっていない名前が${unmapped}件あります。対応表で選んで保存してください。`
        : data.counts.new === 0
          ? data.items.length > 0 && data.items.every((i) => i.decision === "already")
            ? "新しく取り込む仕訳はありません（すべて取込済みです）。"
            : "新しく取り込む仕訳はありません。"
          : `${data.counts.new}件の仕訳を取り込みます。`;
  const selectedYears =
    fiscalYears ?? data?.years.filter((y) => y.hasPeriod).map((y) => y.fiscalYear) ?? [];

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">新しい取込</h1>
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
          <CardTitle>freee の仕訳帳</CardTitle>
          <CardDescription>
            freee から書き出した仕訳帳の CSV を選んでください。取り込む前に内容を確かめられます。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FilePicker label="仕訳帳のファイル" onChange={chooseFile} disabled={commit.isPending} />
          {preview.isFetching && !preview.data && (
            <p className="text-sm text-muted-foreground">ファイルを読み取っています…</p>
          )}
          <ApiErrorMessage error={result === undefined ? preview.error : undefined} />
        </CardContent>
      </Card>

      {result && (
        <div
          role="status"
          className="grid gap-1 rounded-md border border-emerald-600/50 px-4 py-3 text-sm"
        >
          <p className="font-medium">{result.countNew}件の仕訳を取り込みました。</p>
          <p>
            <Link
              to="/e/$entityId/imports/$batchId"
              params={{ entityId, batchId: result.id }}
              className="underline underline-offset-2"
            >
              取込の詳細を見る
            </Link>
          </p>
        </div>
      )}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>プレビュー</CardTitle>
            </CardHeader>
            <CardContent>
              <PreviewSummary preview={data} accounts={accounts.data} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>取り込む年度</CardTitle>
            </CardHeader>
            <CardContent>
              <YearSelector
                entityId={entityId}
                years={data.years}
                selected={selectedYears}
                onChange={setFiscalYears}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>対応表</CardTitle>
              <CardDescription>
                freee の名前ごとに、帳簿の科目と税区分を選びます。「案」は名前から推測したものです。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.data && taxCategories.data ? (
                <MappingEditor
                  entityId={entityId}
                  mappings={data.mappings}
                  accounts={accounts.data}
                  taxCategories={taxCategories.data}
                  accountEdits={accountEdits}
                  taxEdits={taxEdits}
                  onAccountEdit={onAccountEdit}
                  onTaxEdit={onTaxEdit}
                  onSaved={onSaved}
                />
              ) : (
                <p className="text-sm text-muted-foreground">読み込み中…</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>仕訳ごとの判定</CardTitle>
              <CardDescription>
                前年の決算整理などの対象外の仕訳を含めたり、新規の仕訳を個別に外したりできます。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PlanItemsTable
                items={data.items}
                selection={selection}
                onSelectionChange={setSelection}
                disabled={busy}
              />
            </CardContent>
          </Card>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                aria-describedby={statusId}
                disabled={!data.ready || dirty || busy || file === undefined}
                onClick={() => file && commit.mutate({ file, data })}
              >
                取り込む
              </Button>
              <p id={statusId} className="text-sm text-muted-foreground">
                {status}
              </p>
            </div>
            <ApiErrorMessage error={commit.error} />
          </div>
        </>
      )}
    </main>
  );
}
