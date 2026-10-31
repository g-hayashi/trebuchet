import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PasskeyView } from "@trebuchet/schema";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { addPasskey, authKeys, deletePasskey, passkeysQuery, renamePasskey } from "./api";

/** パスキーの一覧（FR-005）。名前の変更・削除・追加。削除できるかどうかはサーバーが決める（LAST_PASSKEY） */
export function PasskeyList() {
  const queryClient = useQueryClient();
  const { data: passkeys, isPending, error } = useQuery(passkeysQuery());
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [deleting, setDeleting] = useState<string>();
  const [newName, setNewName] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: authKeys.passkeys });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
    onSuccess: async () => {
      setRenaming(undefined);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: deletePasskey,
    onSuccess: async () => {
      setDeleting(undefined);
      await refresh();
      // 削除したパスキーのセッションと認証の記録が変わる
      await queryClient.invalidateQueries({ queryKey: authKeys.sessions });
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });
  const add = useMutation({
    mutationFn: () => addPasskey(newName),
    onSuccess: async () => {
      setNewName("");
      await refresh();
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });

  const startRename = (p: PasskeyView) => {
    rename.reset();
    setRenaming({ id: p.id, name: p.name });
  };
  const startDelete = (p: PasskeyView) => {
    remove.reset();
    setDeleting(p.id);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>パスキー</CardTitle>
        <CardDescription>
          帳簿の解錠に使うパスキーです。追加と削除では、パスキーでもう一度確認します。この
          Mac（localhost）の最後の1つは削除できません。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={error} />
        {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {passkeys && (
          <Table aria-label="パスキーの一覧">
            <TableHeader>
              <TableRow>
                <TableHead>名前</TableHead>
                <TableHead>接続先</TableHead>
                <TableHead>登録日</TableHead>
                <TableHead>最後に使った日</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {passkeys.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    {renaming?.id === p.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          rename.mutate({ id: p.id, name: renaming.name });
                        }}
                      >
                        <Input
                          aria-label="パスキーの名前"
                          value={renaming.name}
                          onChange={(event) =>
                            setRenaming({ id: p.id, name: event.currentTarget.value })
                          }
                        />
                        <Button type="submit" size="sm" disabled={rename.isPending}>
                          保存
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(undefined)}>
                          キャンセル
                        </Button>
                      </form>
                    ) : (
                      p.name
                    )}
                  </TableCell>
                  <TableCell>{p.rpId}</TableCell>
                  <TableCell>{formatDateTime(p.createdAt)}</TableCell>
                  <TableCell>{p.lastUsedAt ? formatDateTime(p.lastUsedAt) : "未使用"}</TableCell>
                  <TableCell>
                    {deleting === p.id ? (
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <span className="text-sm">このパスキーを削除しますか</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(p.id)}
                        >
                          削除する
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(undefined)}>
                          キャンセル
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => startRename(p)}>
                          名前の変更
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => startDelete(p)}>
                          削除
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <ApiErrorMessage error={rename.error ?? remove.error} />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="new-passkey-name">追加するパスキーの名前</Label>
            <Input
              id="new-passkey-name"
              autoComplete="off"
              placeholder="省略すると「パスキー」"
              value={newName}
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={add.isPending}>
            パスキーを追加
          </Button>
        </form>
        <ApiErrorMessage error={add.error} />
      </CardContent>
    </Card>
  );
}
