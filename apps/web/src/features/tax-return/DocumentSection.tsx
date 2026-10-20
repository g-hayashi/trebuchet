import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FiledDocumentKind } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type DocumentRow,
  deleteDocument,
  documentsQuery,
  postDocument,
  putDocument,
  taxReturnKeys,
} from "./api";
import { DOCUMENT_KIND_LABELS, DOCUMENT_KINDS, FILE_PATH_ERROR } from "./labels";

type Values = { kind: FiledDocumentKind; filePath: string; filedOn: string; memo: string };

const EMPTY: Values = { kind: "blue_return", filePath: "", filedOn: "", memo: "" };

const valuesOf = (row: DocumentRow): Values => ({
  kind: row.kind,
  filePath: row.filePath,
  filedOn: row.filedOn ?? "",
  memo: row.memo ?? "",
});

/** 提出書類の記録の入力。ファイルの場所は必須で、絶対パス（/ で始まる） */
function DocumentForm({
  entityId,
  year,
  editing,
  onDone,
  notice,
  onSaved,
}: {
  entityId: string;
  year: string;
  editing: DocumentRow | undefined;
  onDone: () => void;
  /** 成功の知らせ。保存すると入力欄を作り直すので、親が持つ */
  notice: string;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(editing ? valuesOf(editing) : EMPTY);
  const [pathError, setPathError] = useState<string>();
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind: values.kind,
        filePath: values.filePath.trim(),
        filedOn: values.filedOn === "" ? null : values.filedOn,
        memo: values.memo.trim() === "" ? null : values.memo,
      };
      return editing
        ? putDocument(entityId, year, editing.id, body)
        : postDocument(entityId, year, body);
    },
    onSuccess: async () => {
      setValues(EMPTY);
      onDone();
      onSaved(editing ? "更新しました。" : "登録しました。");
      await queryClient.invalidateQueries({ queryKey: taxReturnKeys.documents(entityId, year) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const path = values.filePath.trim();
    const error =
      path === ""
        ? "ファイルの場所を入力してください"
        : path.startsWith("/")
          ? undefined
          : FILE_PATH_ERROR;
    setPathError(error);
    if (error) return;
    save.mutate();
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-3 sm:max-w-xl">
      <h3 className="text-sm font-semibold">{editing ? "書類を編集" : "書類の記録"}</h3>
      <div className="grid gap-1">
        <label htmlFor="document-kind" className="text-sm font-medium">
          書類の種類
        </label>
        <NativeSelect
          id="document-kind"
          value={values.kind}
          onChange={(e) => set({ kind: e.target.value as FiledDocumentKind })}
        >
          {DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {DOCUMENT_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <label htmlFor="document-file-path" className="text-sm font-medium">
          書類のファイルの場所
        </label>
        <Input
          id="document-file-path"
          autoComplete="off"
          value={values.filePath}
          onChange={(e) => set({ filePath: e.target.value })}
          aria-invalid={pathError ? true : undefined}
          aria-describedby="document-file-path-error"
        />
        <FieldError id="document-file-path-error" message={pathError} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="document-filed-on" className="text-sm font-medium">
          提出日
        </label>
        <Input
          id="document-filed-on"
          type="date"
          value={values.filedOn}
          onChange={(e) => set({ filedOn: e.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor="document-memo" className="text-sm font-medium">
          書類のメモ
        </label>
        <Input
          id="document-memo"
          autoComplete="off"
          value={values.memo}
          onChange={(e) => set({ memo: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {editing ? "書類を更新" : "書類を登録"}
        </Button>
        {editing && (
          <Button type="button" variant="outline" onClick={onDone}>
            キャンセル
          </Button>
        )}
        <SaveNotice message={notice} />
      </div>
      <ApiErrorMessage error={save.error} />
    </form>
  );
}

/**
 * 提出した書類（青色申告決算書・確定申告書・添付書類）の場所の記録（FR-035）の表と入力。
 * ファイルをコピーも読みもしない。ファイルの有無はサーバーが確かめた結果（FR-036）
 */
export function DocumentSection({ entityId, year }: { entityId: string; year: string }) {
  const queryClient = useQueryClient();
  const documents = useQuery(documentsQuery(entityId, year));
  const [editingId, setEditingId] = useState<string>();
  // 登録・更新の成功の知らせ。保存すると入力欄を作り直すので、ここで持つ
  const [notice, setNotice] = useState("");
  const rows = documents.data ?? [];
  const editing = rows.find((d) => d.id === editingId);

  const remove = useMutation({
    mutationFn: (id: string) => deleteDocument(entityId, year, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: taxReturnKeys.documents(entityId, year) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>提出書類</CardTitle>
        <CardDescription>
          提出した書類の保存場所と提出日を記録します。ファイルのコピーや中身の読み取りはしません。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={documents.error ?? remove.error} />
        {documents.isPending && !documents.error && (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        )}
        {documents.data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">書類はまだ記録されていません。</p>
        )}
        {rows.length > 0 && (
          <Table aria-label="提出書類">
            <TableHeader>
              <TableRow>
                <TableHead>種類</TableHead>
                <TableHead>ファイルの場所</TableHead>
                <TableHead>提出日</TableHead>
                <TableHead>メモ</TableHead>
                <TableHead>ファイル</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{DOCUMENT_KIND_LABELS[d.kind]}</TableCell>
                  <TableCell className="break-all">{d.filePath}</TableCell>
                  <TableCell>{d.filedOn ?? ""}</TableCell>
                  <TableCell>{d.memo ?? ""}</TableCell>
                  <TableCell>{d.fileExists ? "あり" : "見つかりません"}</TableCell>
                  <TableCell className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNotice("");
                        setEditingId(d.id);
                      }}
                    >
                      編集<span className="sr-only">（{DOCUMENT_KIND_LABELS[d.kind]}）</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (
                          !window.confirm(`${DOCUMENT_KIND_LABELS[d.kind]}の記録を削除しますか？`)
                        ) {
                          return;
                        }
                        remove.mutate(d.id);
                      }}
                    >
                      削除<span className="sr-only">（{DOCUMENT_KIND_LABELS[d.kind]}）</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DocumentForm
          key={editing?.id ?? "new"}
          entityId={entityId}
          year={year}
          editing={editing}
          onDone={() => setEditingId(undefined)}
          notice={notice}
          onSaved={setNotice}
        />
      </CardContent>
    </Card>
  );
}
