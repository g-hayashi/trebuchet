import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { EntityCreate } from "@trebuchet/schema";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { createEntity, entitiesQuery, entityKeys } from "@/features/entities/api";
import { entityToRestore } from "@/features/entities/EntitySwitcher";
import { thisYear } from "@/lib/dates";

export const Route = createFileRoute("/")({
  // タブの最初の表示なら、前回の事業体の画面を開く（US6）
  beforeLoad: async ({ context }) => {
    const entityId = await entityToRestore(context.queryClient);
    if (entityId !== undefined) {
      throw redirect({ to: "/e/$entityId", params: { entityId }, replace: true });
    }
  },
  component: HomePage,
});

const KIND_LABELS = { individual: "個人", corporation: "法人" } as const;

function HomePage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[1fr_24rem]">
      <EntityList />
      <EntityCreateForm />
    </main>
  );
}

function EntityList() {
  const { data: entities, isPending, error } = useQuery(entitiesQuery());
  return (
    <Card>
      <CardHeader>
        <CardTitle>事業体</CardTitle>
        <CardDescription>帳簿をつける事業体を選んでください。</CardDescription>
      </CardHeader>
      <CardContent>
        <ApiErrorMessage error={error} />
        {isPending ? (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        ) : entities && entities.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>種別</TableHead>
                <TableHead>作成日</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link
                      to="/e/$entityId"
                      params={{ entityId: e.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell>{KIND_LABELS[e.kind]}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(e.createdAt).toLocaleDateString("ja-JP")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          entities && (
            <p className="text-sm text-muted-foreground">
              事業体がまだありません。右のフォームから作成してください。
            </p>
          )
        )}
      </CardContent>
    </Card>
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
      await queryClient.invalidateQueries({ queryKey: entityKeys.all });
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
