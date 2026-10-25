import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entitiesQuery } from "@/features/entities/api";
import { StatementSettingsForm } from "@/features/statements/StatementSettingsForm";

export const Route = createFileRoute("/settings/statements")({
  component: StatementSettingsPage,
});

function StatementSettingsPage() {
  const entities = useQuery(entitiesQuery());
  const [chosen, setChosen] = useState<string>();
  const entityId = chosen ?? entities.data?.[0]?.id;

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">明細の設定</h1>
      <ApiErrorMessage error={entities.error} />
      {entities.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">事業体がありません。</p>
      )}
      {entities.data && entities.data.length > 0 && entityId !== undefined && (
        <>
          <div className="grid max-w-sm gap-1">
            <Label htmlFor="statement-settings-entity">事業体</Label>
            <NativeSelect
              id="statement-settings-entity"
              value={entityId}
              onChange={(e) => setChosen(e.target.value)}
            >
              {entities.data.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <StatementSettingsForm entityId={entityId} />
        </>
      )}
    </main>
  );
}
