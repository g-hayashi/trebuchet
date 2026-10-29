import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatementSource } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
  deleteStatementSource,
  patchStatementSource,
  statementKeys,
  statementSourcesQuery,
} from "./api";

/** 取込元の種類。口座名の列のない取込元は 1 つの口座（口座の名前を添える）、列のある取込元はまとめ */
const kindText = (source: StatementSource) =>
  source.fixedAccountName === null ? "まとめ" : `1 つの口座（${source.fixedAccountName}）`;

/** 1 行の名前の変更の欄 */
function RenameRow({
  entityId,
  source,
  onDone,
}: {
  entityId: string;
  source: StatementSource;
  onDone: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(source.name);
  const rename = useMutation({
    mutationFn: () => patchStatementSource(entityId, source.id, name.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statementKeys.sources(entityId) });
      onDone();
    },
  });
  return (
    <form
      noValidate
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== "") rename.mutate();
      }}
    >
      <label htmlFor={id} className="sr-only">
        「{source.name}」の新しい名前
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          autoComplete="off"
          maxLength={100}
          className="w-64"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          disabled={name.trim() === "" || rename.isPending}
          aria-label={`「${source.name}」の名前を保存`}
        >
          保存
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          やめる
        </Button>
      </div>
      <ApiErrorMessage error={rename.error} />
    </form>
  );
}

/**
 * 取込元の一覧（007 US2。H:§3）: 名前・種類・最後に使った日時。名前の変更と削除ができる。
 * 削除しても、取り込み済みの明細・取込の履歴・登録済みの仕訳は変わらない（次の取込で列の対応を選び直すことになる）
 */
export function SourceList({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const sources = useQuery(statementSourcesQuery(entityId));
  const [renaming, setRenaming] = useState<string | undefined>();
  const remove = useMutation({
    mutationFn: (id: string) => deleteStatementSource(entityId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: statementKeys.sources(entityId) }),
  });

  const confirmRemove = (source: StatementSource) => {
    if (
      window.confirm(
        `取込元「${source.name}」を削除しますか？取り込み済みの明細と登録済みの仕訳は変わりません。次の取込では、列の対応を選び直します。`,
      )
    ) {
      remove.reset();
      remove.mutate(source.id);
    }
  };

  return (
    <section aria-label="取込元" className="grid gap-3">
      <h2 className="text-lg font-semibold">取込元</h2>
      <p className="text-sm text-muted-foreground">
        取込のときに保存した、列の対応です。同じ形の明細を取り込むと、自動で当てはまります。
      </p>
      <ApiErrorMessage error={sources.error ?? remove.error} />
      {sources.data &&
        (sources.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">保存した取込元はまだありません。</p>
        ) : (
          <Table aria-label="取込元の一覧">
            <TableHeader>
              <TableRow>
                <TableHead>名前</TableHead>
                <TableHead>種類</TableHead>
                <TableHead>最後に使った日時</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    {renaming === s.id ? (
                      <RenameRow
                        entityId={entityId}
                        source={s}
                        onDone={() => setRenaming(undefined)}
                      />
                    ) : (
                      s.name
                    )}
                  </TableCell>
                  <TableCell>{kindText(s)}</TableCell>
                  <TableCell>{new Date(s.lastUsedAt).toLocaleString("ja-JP")}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={renaming === s.id}
                        aria-label={`「${s.name}」の名前を変更`}
                        onClick={() => setRenaming(s.id)}
                      >
                        名前を変更
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={remove.isPending}
                        aria-label={`「${s.name}」を削除`}
                        onClick={() => confirmRemove(s)}
                      >
                        削除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}
