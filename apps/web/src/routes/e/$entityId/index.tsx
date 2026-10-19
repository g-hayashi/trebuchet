import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EntityPatch } from "@trebuchet/schema";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, unwrap } from "@/lib/api";
import { entitiesQuery, queryKeys } from "@/lib/queries";

export const Route = createFileRoute("/e/$entityId/")({
  component: EntityHome,
});

function EntityHome() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const entity = entities?.find((e) => e.id === entityId);
  return (
    <main className="grid gap-6">
      <p className="text-sm text-muted-foreground">メニューから操作を選んでください。</p>
      {entity && <RenameEntityForm key={entity.name} entityId={entityId} name={entity.name} />}
    </main>
  );
}

function RenameEntityForm({ entityId, name }: { entityId: string; name: string }) {
  const queryClient = useQueryClient();
  const form = useForm<z.input<typeof EntityPatch>, unknown, EntityPatch>({
    resolver: zodResolver(EntityPatch),
    defaultValues: { name },
  });
  const message = form.formState.errors.name?.message;
  const rename = useMutation({
    mutationFn: async (json: EntityPatch) =>
      unwrap(await api.api.entities[":entityId"].$patch({ param: { entityId }, json })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.entities }),
  });

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>事業体の名称</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-2"
          onSubmit={form.handleSubmit((v) => rename.mutate(v))}
        >
          <Label htmlFor="entity-rename">名称</Label>
          <div className="flex gap-2">
            <Input
              id="entity-rename"
              autoComplete="off"
              aria-invalid={message ? true : undefined}
              aria-describedby="entity-rename-error"
              {...form.register("name")}
            />
            <Button type="submit" disabled={rename.isPending || !form.formState.isDirty}>
              変更する
            </Button>
          </div>
          <FieldError id="entity-rename-error" message={message} />
          <ApiErrorMessage error={rename.error} />
        </form>
      </CardContent>
    </Card>
  );
}
