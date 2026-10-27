import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StatementAccountInput,
  StatementEncoding,
  StatementImportPreview,
  StatementLayoutOptions,
  StatementPreviewOptions,
  StatementTableLayout,
} from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { AccountMappingForm } from "./AccountMappingForm";
import {
  importBatchesQuery,
  postImportCommit,
  postImportLayout,
  postImportPreview,
  putStatementAccount,
  statementKeys,
} from "./api";
import {
  type ColumnMappingDraft,
  ColumnMappingEditor,
  type RelayoutChoice,
} from "./ColumnMappingEditor";
import { ImportPreview } from "./ImportPreview";
import { ORIGIN_LABELS } from "./labels";
import { StatementInput, type StatementInputValue } from "./StatementInput";

/** 取込の履歴（H:§3.3。新しい順） */
function BatchHistory({ entityId }: { entityId: string }) {
  const { data, error } = useQuery(importBatchesQuery(entityId));
  return (
    <section aria-label="取込の履歴" className="grid gap-2">
      <h2 className="text-lg font-semibold">取込の履歴</h2>
      <ApiErrorMessage error={error} />
      {data &&
        (data.length === 0 ? (
          <p className="text-sm text-muted-foreground">取り込んだ記録はまだありません。</p>
        ) : (
          <Table aria-label="取込の履歴">
            <TableHeader>
              <TableRow>
                <TableHead>取込日時</TableHead>
                <TableHead>取込元</TableHead>
                <TableHead>期間</TableHead>
                <TableHead className="text-right">新規</TableHead>
                <TableHead className="text-right">取込済み</TableHead>
                <TableHead className="text-right">読めない行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{new Date(b.createdAt).toLocaleString("ja-JP")}</TableCell>
                  <TableCell>{ORIGIN_LABELS[b.origin]}</TableCell>
                  <TableCell>
                    {b.periodFrom} 〜 {b.periodTo}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.countNew}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.countExisting}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.countUnreadable}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}

/** 読み取った入力。プレビューと確定は、読み取りと同じファイルを送る */
type Input = StatementInputValue;

/** プレビューを作ったときの、ファイルと指定。確定・口座の対応の後の作り直しは、これをそのまま使う */
type Request = { file: File; options: StatementPreviewOptions };

/**
 * 明細の取込の画面（US1）: 入力（貼り付け・ファイル）→ 列の対応 → 確認（プレビュー・口座の対応）→ 確定。
 * 口座の対応を保存したら、同じファイルと指定でプレビューを作り直す。確定が `STATEMENT_PLAN_CHANGED` のときも作り直す。
 * 確定は、直近のプレビューと同じファイルと指定を送る（列の対応を触っても、プレビューのままで確定する）
 */
export function ImportWorkspace({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState<Input | undefined>();
  const [inputVersion, setInputVersion] = useState(0);
  const [layout, setLayout] = useState<StatementTableLayout | undefined>();
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [encodingOverride, setEncodingOverride] = useState<StatementEncoding | undefined>();
  const [request, setRequest] = useState<Request | undefined>();
  const [preview, setPreview] = useState<StatementImportPreview | undefined>();
  const [notice, setNotice] = useState("");

  const layoutMutation = useMutation({
    mutationFn: ({ file, options }: { file: File; options: StatementLayoutOptions }) =>
      postImportLayout(entityId, file, options),
    onSuccess: (result, { options }) => {
      setLayout(result);
      setLayoutVersion((v) => v + 1);
      setEncodingOverride(options.encoding);
      setRequest(undefined);
      setPreview(undefined);
    },
  });

  const previewMutation = useMutation({
    mutationFn: (r: Request) => postImportPreview(entityId, r.file, r.options),
    onSuccess: (result, r) => {
      setRequest(r);
      setPreview(result);
    },
    onError: () => setPreview(undefined),
  });

  const saveMutation = useMutation({
    mutationFn: ({ name, input: accountInput }: { name: string; input: StatementAccountInput }) =>
      putStatementAccount(entityId, name, accountInput),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statementKeys.accounts(entityId) });
      if (request) previewMutation.mutate(request);
    },
  });

  const commitMutation = useMutation({
    mutationFn: ({
      r,
      expected,
    }: {
      r: Request;
      expected: { inputSha256: string; countNew: number };
    }) =>
      postImportCommit(entityId, r.file, {
        ...r.options,
        expected,
        accounts: [],
        saveSource: null,
      }),
    onSuccess: async (result) => {
      setNotice(
        `${result.added} 件を取り込みました${result.changed > 0 ? `（変更あり ${result.changed} 件）` : ""}。`,
      );
      // 取り込んだら入力から始め直す
      setInput(undefined);
      setLayout(undefined);
      setRequest(undefined);
      setPreview(undefined);
      setInputVersion((v) => v + 1);
      await queryClient.invalidateQueries({ queryKey: statementKeys.batches(entityId) });
    },
    onError: (e, { r }) => {
      // プレビューの後に内容が変わったときは、作り直して見せる
      if (e instanceof ApiError && e.code === "STATEMENT_PLAN_CHANGED") previewMutation.mutate(r);
    },
  });

  const resetResults = () => {
    setNotice("");
    commitMutation.reset();
    previewMutation.reset();
  };

  const startLayout = (next: Input) => {
    resetResults();
    // 新しい入力の判定が終わるまで、前の入力の列の対応・プレビューは見せない
    setLayout(undefined);
    setRequest(undefined);
    setPreview(undefined);
    setInput(next);
    layoutMutation.mutate({ file: next.file, options: { origin: next.origin } });
  };

  const relayout = (choice: RelayoutChoice) => {
    if (!input) return;
    resetResults();
    layoutMutation.mutate({
      file: input.file,
      options: {
        origin: input.origin,
        delimiter: choice.delimiter,
        headerRow: choice.headerRow,
        ...(choice.encoding === undefined ? {} : { encoding: choice.encoding }),
      },
    });
  };

  const startPreview = (draft: ColumnMappingDraft) => {
    if (!input || !layout) return;
    resetResults();
    previewMutation.mutate({
      file: input.file,
      options: {
        origin: input.origin,
        year: draft.year,
        mapping: draft.mapping,
        // 読み取りで使った文字コードを、プレビューと確定にも送る
        encoding: layout.encoding,
        ...(draft.fixedAccountName === undefined
          ? {}
          : { fixedAccountName: draft.fixedAccountName }),
      },
    });
  };

  const changedCount = preview?.rows.filter((r) => r.status === "changed").length ?? 0;
  const unmapped = preview?.unmappedAccounts ?? [];
  const nothingToImport = preview !== undefined && preview.countNew === 0 && changedCount === 0;
  const canCommit =
    preview !== undefined &&
    request !== undefined &&
    unmapped.length === 0 &&
    !nothingToImport &&
    !commitMutation.isPending;

  return (
    <div className="grid gap-8">
      <section aria-label="入力" className="grid gap-3">
        <StatementInput
          key={inputVersion}
          pending={layoutMutation.isPending}
          onRead={startLayout}
        />
        <ApiErrorMessage error={layoutMutation.error} />
        {notice && <SaveNotice message={notice} />}
      </section>

      {layout && (
        <section aria-label="列の対応" className="grid gap-4">
          <h2 className="text-lg font-semibold">列の対応</h2>
          <ColumnMappingEditor
            key={layoutVersion}
            entityId={entityId}
            layout={layout}
            encodingOverride={encodingOverride}
            pending={layoutMutation.isPending || previewMutation.isPending}
            onRelayout={relayout}
            onConfirm={startPreview}
          />
          <ApiErrorMessage error={previewMutation.error} />
        </section>
      )}

      {preview && (
        <section aria-label="プレビュー" className="grid gap-4">
          <h2 className="text-lg font-semibold">プレビュー</h2>
          <ImportPreview preview={preview} />

          {unmapped.length > 0 && (
            <div className="grid gap-3">
              <h3 className="font-medium">口座の対応</h3>
              <p className="text-sm text-muted-foreground">
                対応づいていない口座があります。用途と科目を決めると、プレビューを作り直します。
              </p>
              {unmapped.map(({ name }) => (
                <AccountMappingForm
                  key={name}
                  entityId={entityId}
                  name={name}
                  saving={saveMutation.isPending}
                  error={saveMutation.variables?.name === name ? saveMutation.error : undefined}
                  onSave={(n, accountInput) =>
                    saveMutation.mutate({ name: n, input: accountInput })
                  }
                />
              ))}
            </div>
          )}

          {nothingToImport && (
            <p className="text-sm text-muted-foreground">新しく取り込む明細はありません。</p>
          )}
          <ApiErrorMessage error={commitMutation.error} />
          <div>
            <Button
              disabled={!canCommit}
              onClick={() =>
                request &&
                commitMutation.mutate({
                  r: request,
                  expected: { inputSha256: preview.inputSha256, countNew: preview.countNew },
                })
              }
            >
              取り込む
            </Button>
          </div>
        </section>
      )}

      <BatchHistory entityId={entityId} />
    </div>
  );
}
