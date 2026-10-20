import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaxReturnMemoKind } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen, parseYenInput } from "@/lib/format";
import { deleteMemo, type MemoRow, memosQuery, postMemo, putMemo, taxReturnKeys } from "./api";
import { FILE_PATH_ERROR, MEMO_KIND_LABELS, MEMO_KINDS, memoKindText } from "./labels";

const AMOUNT_ERROR = "金額は 0 以上の整数で入力してください";
const LABEL_ERROR = "「その他」のときは項目名を入力してください";

type Values = {
  kind: TaxReturnMemoKind;
  label: string;
  amount: string;
  filePath: string;
  memo: string;
};

const EMPTY: Values = { kind: "salary", label: "", amount: "", filePath: "", memo: "" };

const valuesOf = (row: MemoRow): Values => ({
  kind: row.kind,
  label: row.label ?? "",
  amount: row.amount === null ? "" : String(row.amount),
  filePath: row.filePath ?? "",
  memo: row.memo ?? "",
});

type Errors = { amount?: string; filePath?: string; label?: string };

/** 控えの入力。決算書の計算には使わない（FR-034）。金額・場所の形を整えて送る */
function MemoForm({
  entityId,
  year,
  editing,
  onDone,
}: {
  entityId: string;
  year: string;
  editing: MemoRow | undefined;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(editing ? valuesOf(editing) : EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));

  const save = useMutation({
    mutationFn: (amount: number | null) => {
      const body = {
        kind: values.kind,
        label: values.label.trim() === "" ? null : values.label,
        amount,
        filePath: values.filePath.trim() === "" ? null : values.filePath.trim(),
        memo: values.memo.trim() === "" ? null : values.memo,
      };
      return editing ? putMemo(entityId, year, editing.id, body) : postMemo(entityId, year, body);
    },
    onSuccess: async () => {
      setValues(EMPTY);
      onDone();
      await queryClient.invalidateQueries({ queryKey: taxReturnKeys.memos(entityId, year) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const amountText = values.amount.trim();
    const amount = amountText === "" ? null : parseYenInput(amountText);
    const next: Errors = {};
    if (
      amount === undefined ||
      (amount !== null && (!Number.isSafeInteger(amount) || amount < 0))
    ) {
      next.amount = AMOUNT_ERROR;
    }
    const path = values.filePath.trim();
    if (path !== "" && !path.startsWith("/")) next.filePath = FILE_PATH_ERROR;
    if (values.kind === "other" && values.label.trim() === "") next.label = LABEL_ERROR;
    setErrors(next);
    if (next.amount || next.filePath || next.label || amount === undefined) return;
    save.mutate(amount);
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-3 sm:max-w-xl">
      <h3 className="text-sm font-semibold">{editing ? "控えを編集" : "控えの登録"}</h3>
      <div className="grid gap-1">
        <label htmlFor="memo-kind" className="text-sm font-medium">
          控えの種類
        </label>
        <NativeSelect
          id="memo-kind"
          value={values.kind}
          onChange={(e) => set({ kind: e.target.value as TaxReturnMemoKind })}
        >
          {MEMO_KINDS.map((k) => (
            <option key={k} value={k}>
              {MEMO_KIND_LABELS[k]}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-1">
        <label htmlFor="memo-label" className="text-sm font-medium">
          控えの項目名
        </label>
        <Input
          id="memo-label"
          autoComplete="off"
          value={values.label}
          onChange={(e) => set({ label: e.target.value })}
          aria-invalid={errors.label ? true : undefined}
          aria-describedby="memo-label-error"
        />
        <FieldError id="memo-label-error" message={errors.label} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="memo-amount" className="text-sm font-medium">
          控えの金額
        </label>
        <Input
          id="memo-amount"
          inputMode="numeric"
          autoComplete="off"
          value={values.amount}
          onChange={(e) => set({ amount: e.target.value })}
          aria-invalid={errors.amount ? true : undefined}
          aria-describedby="memo-amount-error"
        />
        <FieldError id="memo-amount-error" message={errors.amount} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="memo-file-path" className="text-sm font-medium">
          控えのファイルの場所
        </label>
        <Input
          id="memo-file-path"
          autoComplete="off"
          value={values.filePath}
          onChange={(e) => set({ filePath: e.target.value })}
          aria-invalid={errors.filePath ? true : undefined}
          aria-describedby="memo-file-path-error"
        />
        <FieldError id="memo-file-path-error" message={errors.filePath} />
      </div>
      <div className="grid gap-1">
        <label htmlFor="memo-memo" className="text-sm font-medium">
          控えのメモ
        </label>
        <Input
          id="memo-memo"
          autoComplete="off"
          value={values.memo}
          onChange={(e) => set({ memo: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {editing ? "控えを更新" : "控えを登録"}
        </Button>
        {editing && (
          <Button type="button" variant="outline" onClick={onDone}>
            キャンセル
          </Button>
        )}
      </div>
      <ApiErrorMessage error={save.error} />
    </form>
  );
}

/**
 * 事業所得以外の控え（給与・社会保険料・寄附金など。FR-033）の表と入力。金額とファイルの場所を
 * 控えるだけで、決算書には使わない（FR-034）。ファイルの有無はサーバーが確かめた結果（FR-036）
 */
export function MemoSection({ entityId, year }: { entityId: string; year: string }) {
  const queryClient = useQueryClient();
  const memos = useQuery(memosQuery(entityId, year));
  const [editingId, setEditingId] = useState<string>();
  const rows = memos.data ?? [];
  const editing = rows.find((m) => m.id === editingId);

  const remove = useMutation({
    mutationFn: (id: string) => deleteMemo(entityId, year, id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: taxReturnKeys.memos(entityId, year) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>事業所得以外の控え</CardTitle>
        <CardDescription>
          給与・各種控除など、事業所得以外の金額と書類の場所を控えます。決算書の計算には使いません。ファイルの中身は読みません。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={memos.error ?? remove.error} />
        {memos.isPending && !memos.error && (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        )}
        {memos.data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">控えはまだ登録されていません。</p>
        )}
        {rows.length > 0 && (
          <Table aria-label="事業所得以外の控え">
            <TableHeader>
              <TableRow>
                <TableHead>種類</TableHead>
                <TableHead className="text-right">金額</TableHead>
                <TableHead>ファイルの場所</TableHead>
                <TableHead>メモ</TableHead>
                <TableHead>ファイル</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{memoKindText(m.kind, m.label)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.amount === null ? "" : formatYen(m.amount)}
                  </TableCell>
                  <TableCell className="break-all">{m.filePath ?? ""}</TableCell>
                  <TableCell>{m.memo ?? ""}</TableCell>
                  <TableCell>
                    {m.filePath === null ? "" : m.fileExists ? "あり" : "見つかりません"}
                  </TableCell>
                  <TableCell className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingId(m.id)}>
                      編集<span className="sr-only">（{memoKindText(m.kind, m.label)}）</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (
                          !window.confirm(`${memoKindText(m.kind, m.label)}の控えを削除しますか？`)
                        ) {
                          return;
                        }
                        remove.mutate(m.id);
                      }}
                    >
                      削除<span className="sr-only">（{memoKindText(m.kind, m.label)}）</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <MemoForm
          // 編集する控えを切り替えたら入力欄を作り直す
          key={editing?.id ?? "new"}
          entityId={entityId}
          year={year}
          editing={editing}
          onDone={() => setEditingId(undefined)}
        />
      </CardContent>
    </Card>
  );
}
