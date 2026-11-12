import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { TagCreate } from "@trebuchet/schema";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { masterKeys, postTag, tagsQuery } from "@/features/masters/api";

export const Route = createFileRoute("/e/$entityId/tags")({
  component: TagsPage,
});

function TagsPage() {
  const { entityId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: tags, isPending, error } = useQuery(tagsQuery(entityId));
  const form = useForm<z.input<typeof TagCreate>, unknown, TagCreate>({
    resolver: zodResolver(TagCreate),
    defaultValues: { name: "" },
  });
  const message = form.formState.errors.name?.message;

  const create = useMutation({
    mutationFn: (json: TagCreate) => postTag(entityId, json),
    onSuccess: async () => {
      form.reset({ name: "" });
      await queryClient.invalidateQueries({ queryKey: masterKeys.tags(entityId) });
    },
  });

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">メモタグ</h1>
      <Card>
        <CardHeader>
          <CardTitle>タグの一覧</CardTitle>
          <CardDescription>仕訳の行に複数付けて、あとから絞り込めます。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {isPending && <Loading />}
          {tags && tags.length === 0 && (
            <p className="text-sm text-muted-foreground">タグはまだありません。</p>
          )}
          {tags && tags.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="タグ">
              {tags.map((t) => (
                <li key={t.id} className="rounded-full border px-3 py-1 text-sm">
                  {t.name}
                </li>
              ))}
            </ul>
          )}
          <form
            noValidate
            className="flex flex-wrap items-center gap-2"
            onSubmit={form.handleSubmit((v) => create.mutate(v))}
          >
            <Label htmlFor="tag-name">タグを追加</Label>
            <Input
              id="tag-name"
              className="max-w-60"
              autoComplete="off"
              aria-invalid={message ? true : undefined}
              aria-describedby="tag-name-error"
              {...form.register("name")}
            />
            <Button type="submit" disabled={create.isPending}>
              追加する
            </Button>
            <FieldError id="tag-name-error" message={message} />
          </form>
          <ApiErrorMessage error={create.error} />
        </CardContent>
      </Card>
    </main>
  );
}
