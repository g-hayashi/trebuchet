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
import { entitiesQuery, entityKeys, patchEntity } from "@/features/entities/api";

export const Route = createFileRoute("/e/$entityId/settings")({
  component: EntitySettings,
});

/** 事業体の設定の「基本」。事業体の名前の変更（FR-052。以前はホームにあった） */
function EntitySettings() {
  const { entityId } = Route.useParams();
  const { data: entities } = useQuery(entitiesQuery());
  const entity = entities?.find((e) => e.id === entityId);
  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">基本</h1>
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
    mutationFn: (json: EntityPatch) => patchEntity(entityId, json),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: entityKeys.all }),
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
