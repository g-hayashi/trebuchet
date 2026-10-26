import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatementAccountInput, StatementImportPreview } from "@trebuchet/schema";
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
  type ImportSource,
  importBatchesQuery,
  postImportCommit,
  postImportPreview,
  putStatementAccount,
  statementKeys,
} from "./api";
import { ImportPreview } from "./ImportPreview";
import { ORIGIN_LABELS } from "./labels";
import { PasteImport } from "./PasteImport";

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

/**
 * 明細の取込の画面（US1）: 貼り付け → プレビュー → 未対応の口座の対応 → 確定。
 * 口座の対応を保存したら、同じ入力でプレビューを作り直す。確定が `STATEMENT_PLAN_CHANGED` のときも作り直す
 */
export function ImportWorkspace({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ImportSource | undefined>();
  const [preview, setPreview] = useState<StatementImportPreview | undefined>();
  const [notice, setNotice] = useState("");

  const previewMutation = useMutation({
    mutationFn: (s: ImportSource) => postImportPreview(entityId, s),
    onSuccess: (result, s) => {
      setSource(s);
      setPreview(result);
    },
    onError: () => setPreview(undefined),
  });

  const saveMutation = useMutation({
    mutationFn: ({ name, input }: { name: string; input: StatementAccountInput }) =>
      putStatementAccount(entityId, name, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statementKeys.accounts(entityId) });
      if (source) previewMutation.mutate(source);
    },
  });

  const commitMutation = useMutation({
    mutationFn: ({
      s,
      expected,
    }: {
      s: ImportSource;
      expected: { inputSha256: string; countNew: number };
    }) => postImportCommit(entityId, s, expected),
    onSuccess: async (result) => {
      setNotice(
        `${result.added} 件を取り込みました${result.changed > 0 ? `（変更あり ${result.changed} 件）` : ""}。`,
      );
      setPreview(undefined);
      await queryClient.invalidateQueries({ queryKey: statementKeys.batches(entityId) });
    },
    onError: (e, { s }) => {
      // プレビューの後に内容が変わったときは、作り直して見せる
      if (e instanceof ApiError && e.code === "STATEMENT_PLAN_CHANGED") previewMutation.mutate(s);
    },
  });

  const startPreview = (s: ImportSource) => {
    setNotice("");
    commitMutation.reset();
    previewMutation.mutate(s);
  };

  const changedCount = preview?.rows.filter((r) => r.status === "changed").length ?? 0;
  const unmapped = preview?.unmappedAccounts ?? [];
  const nothingToImport = preview !== undefined && preview.countNew === 0 && changedCount === 0;
  const canCommit =
    preview !== undefined &&
    source !== undefined &&
    unmapped.length === 0 &&
    !nothingToImport &&
    !commitMutation.isPending;

  return (
    <div className="grid gap-8">
      <section aria-label="貼り付け" className="grid gap-3">
        <PasteImport pending={previewMutation.isPending} onPreview={startPreview} />
        <ApiErrorMessage error={previewMutation.error} />
        {notice && <SaveNotice message={notice} />}
      </section>

      {preview && (
        <section aria-label="プレビュー" className="grid gap-4">
          <h2 className="text-lg font-semibold">プレビュー</h2>
          <ImportPreview preview={preview} />

          {unmapped.length > 0 && (
            <div className="grid gap-3">
              <h3 className="font-medium">口座の対応</h3>
              <p className="text-sm text-muted-foreground">
                対応づいていない保有金融機関があります。用途と科目を決めると、プレビューを作り直します。
              </p>
              {unmapped.map(({ name }) => (
                <AccountMappingForm
                  key={name}
                  entityId={entityId}
                  name={name}
                  saving={saveMutation.isPending}
                  error={saveMutation.variables?.name === name ? saveMutation.error : undefined}
                  onSave={(n, input) => saveMutation.mutate({ name: n, input })}
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
                source &&
                commitMutation.mutate({
                  s: source,
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
