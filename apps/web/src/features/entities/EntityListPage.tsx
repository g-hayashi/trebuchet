import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { EntityCreate } from "@trebuchet/schema";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  archivedEntitiesKey,
  archivedEntitiesQuery,
  archiveEntity,
  createDemoEntity,
  createEntity,
  entitiesQuery,
  entityKeys,
  purgeEntity,
  restoreEntity,
} from "@/features/entities/api";
import { lastEntityIdOf } from "@/features/entities/EntitySwitcher";
import { thisYear } from "@/lib/dates";
import { formatDateTime } from "@/lib/format";
import { getStored, removeStored, storageKeys } from "@/lib/local-storage";

const KIND_LABELS = { individual: "個人", corporation: "法人" } as const;

export function EntityListPage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_24rem]">
      <EntityList />
      <EntityCreateForm />
    </main>
  );
}

function EntityList() {
  const queryClient = useQueryClient();
  const { data: loaded, isPending, error } = useQuery(entitiesQuery());
  const archived = useQuery(archivedEntitiesQuery());
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [confirmationName, setConfirmationName] = useState("");
  const manage = useMutation({
    mutationFn: async ({
      id,
      action,
      name,
    }: {
      id: string;
      action: "archive" | "restore" | "purge";
      name?: string;
    }) => {
      if (action === "archive") await archiveEntity(id);
      else if (action === "restore") await restoreEntity(id);
      else await purgeEntity(id, name ?? "");
      return { id, action };
    },
    onSuccess: async ({ id, action }) => {
      // 非表示・削除した帳簿のキャッシュと最後に開いた選択を残さない。
      if (action !== "restore") {
        queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey.includes(id) });
        if (getStored(storageKeys.lastEntityId) === id) removeStored(storageKeys.lastEntityId);
      }
      setTarget(null);
      setConfirmationName("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: entityKeys.all, exact: true }),
        queryClient.invalidateQueries({ queryKey: archivedEntitiesKey }),
      ]);
    },
  });
  // 最後に開いた事業体を上に置き、印をつける（FR-010）
  const lastId = lastEntityIdOf(loaded);
  const entities = loaded && [
    ...loaded.filter((e) => e.id === lastId),
    ...loaded.filter((e) => e.id !== lastId),
  ];
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>事業体</CardTitle>
        <CardDescription>帳簿をつける事業体を選んでください。</CardDescription>
      </CardHeader>
      <CardContent>
        <ApiErrorMessage error={error} />
        {!target && <ApiErrorMessage error={manage.error} />}
        {isPending ? (
          <Loading />
        ) : entities && entities.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="hidden sm:table-cell">種別</TableHead>
                <TableHead className="hidden sm:table-cell">作成日</TableHead>
                <TableHead>証憑</TableHead>
                <TableHead>管理</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((e) => (
                <TableRow key={e.id} className={e.id === lastId ? "bg-accent/50" : undefined}>
                  <TableCell>
                    <Link
                      to="/e/$entityId"
                      params={{ entityId: e.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {e.name}
                    </Link>
                    {e.demo && (
                      <span className="ml-2 rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                        デモ
                      </span>
                    )}
                    {e.id === lastId && (
                      <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                        最後に開いた
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{KIND_LABELS[e.kind]}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDateTime(e.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/e/$entityId/receipts/new"
                      params={{ entityId: e.id }}
                      className="underline-offset-4 hover:underline"
                    >
                      証憑を追加
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={manage.isPending}
                      onClick={() => manage.mutate({ id: e.id, action: "archive" })}
                    >
                      非表示にする
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          entities && (
            <>
              <p className="text-sm text-muted-foreground">
                事業体がまだありません。右のフォームから作成してください。
              </p>
              <DemoEntityStart />
            </>
          )
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          非表示にしても帳簿・証憑は保持されます。「非表示の組織」から復元・完全削除できます。
        </p>
        <details className="mt-6 border-t pt-4">
          <summary className="cursor-pointer font-medium">非表示の組織</summary>
          <div className="mt-4 grid gap-3">
            <ApiErrorMessage error={archived.error} />
            {archived.isPending && <Loading />}
            {archived.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">非表示の組織はありません。</p>
            )}
            {archived.data?.map((e) => (
              <div
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"
              >
                <div>
                  <p className="font-medium">{e.name}</p>
                  {e.status === "deleting" && (
                    <p className="text-sm text-muted-foreground">
                      削除処理中です。完全削除を再試行してください。
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={manage.isPending || e.status === "deleting"}
                    onClick={() => manage.mutate({ id: e.id, action: "restore" })}
                  >
                    一覧に戻す
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={manage.isPending}
                    onClick={() => {
                      manage.reset();
                      setConfirmationName("");
                      setTarget(e);
                    }}
                  >
                    完全に削除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </details>
        <Dialog
          open={target !== null}
          onOpenChange={(open) => {
            if (!open && !manage.isPending) {
              setTarget(null);
              manage.reset();
            }
          }}
        >
          <DialogContent>
            <DialogTitle>「{target?.name}」を完全に削除</DialogTitle>
            <DialogDescription>
              この組織の帳簿・仕訳・設定・証憑を端末から削除します。元に戻せません。他の組織と既存のバックアップは保持されます。バックアップを復元すると、この組織のデータも戻る場合があります。
            </DialogDescription>
            <div className="grid gap-2">
              <Label htmlFor="purge-name">確認の名称</Label>
              <p className="text-sm text-muted-foreground">
                削除する組織名「{target?.name}」を入力してください。
              </p>
              <Input
                id="purge-name"
                autoComplete="off"
                value={confirmationName}
                onChange={(event) => setConfirmationName(event.target.value)}
                disabled={manage.isPending}
              />
            </div>
            <ApiErrorMessage error={manage.error} />
            <DialogFooter>
              <Button
                variant="outline"
                disabled={manage.isPending}
                onClick={() => {
                  setTarget(null);
                  manage.reset();
                }}
              >
                キャンセル
              </Button>
              <Button
                variant="destructive"
                disabled={manage.isPending || confirmationName !== target?.name}
                onClick={() => {
                  if (target)
                    manage.mutate({ id: target.id, action: "purge", name: confirmationName });
                }}
              >
                {manage.isPending ? "削除中…" : "完全に削除"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** 事業体が 0 件のときの、デモ事業（架空のデータ。014）の作成。成功したらデモのホームへ移る */
function DemoEntityStart() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: createDemoEntity,
    onSuccess: async (entity) => {
      await queryClient.invalidateQueries({ queryKey: entityKeys.all, exact: true });
      await navigate({ to: "/e/$entityId", params: { entityId: entity.id } });
    },
  });
  return (
    <div className="mt-4 grid gap-3">
      <p className="text-sm text-muted-foreground">
        架空のデータで機能を試せる事業体を作ります。試し終わったら削除できます。
      </p>
      <ApiErrorMessage error={create.error} />
      <div>
        <Button variant="outline" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "作成中…" : "デモ事業を作って試す"}
        </Button>
      </div>
    </div>
  );
}

type EntityCreateInput = z.input<typeof EntityCreate>;

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

function EntityCreateForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<EntityCreateInput, unknown, EntityCreate>({
    resolver: zodResolver(EntityCreate),
    defaultValues: {
      name: "",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: thisYear(),
    },
  });
  const { errors } = form.formState;

  const create = useMutation({
    mutationFn: (input: EntityCreate) => createEntity(input),
    onSuccess: async (entity) => {
      await queryClient.invalidateQueries({ queryKey: entityKeys.all, exact: true });
      await navigate({ to: "/e/$entityId", params: { entityId: entity.id } });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>事業体を作成</CardTitle>
        <CardDescription>
          勘定科目の初期セット、最初の会計期間、消費税の設定（免税・税込経理）が用意されます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit((values) => create.mutate(values))}
        >
          <div className="grid gap-2">
            <Label htmlFor="entity-name">名称</Label>
            <Input
              id="entity-name"
              autoComplete="off"
              placeholder="例: 個人事業"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby="entity-name-error"
              {...form.register("name")}
            />
            <FieldError id="entity-name-error" message={errors.name?.message} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="entity-kind">種別</Label>
            <NativeSelect id="entity-kind" {...form.register("kind")}>
              <option value="individual">個人</option>
              <option value="corporation">法人（科目は個人用の初期セット）</option>
            </NativeSelect>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">個人・法人の違い</summary>
              <div className="mt-3 grid gap-2 leading-relaxed text-muted-foreground">
                <p>
                  個人：期首は1月です。青色申告決算書、家事按分、固定資産・減価償却、開業費の機能を使えます。
                </p>
                <p>
                  法人：期首月を1〜12月から選べます。青色申告決算書と、それに付随する家事按分・固定資産・減価償却・開業費の機能は使えません。法人税の申告には対応していません。
                </p>
                <p>
                  仕訳・帳簿・通常の集計帳票は共通です。勘定科目の初期セットはどちらも個人用で、消費税の初期設定は免税・税込経理です。
                </p>
              </div>
            </details>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="entity-first-year">開始年度</Label>
              <Input
                id="entity-first-year"
                type="number"
                inputMode="numeric"
                aria-invalid={errors.firstFiscalYear ? true : undefined}
                aria-describedby="entity-first-year-error"
                {...form.register("firstFiscalYear", { valueAsNumber: true })}
              />
              <FieldError id="entity-first-year-error" message={errors.firstFiscalYear?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="entity-start-month">期首の月</Label>
              <NativeSelect
                id="entity-start-month"
                {...form.register("fiscalStartMonth", { valueAsNumber: true })}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}月
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <ApiErrorMessage error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "作成中…" : "作成する"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
