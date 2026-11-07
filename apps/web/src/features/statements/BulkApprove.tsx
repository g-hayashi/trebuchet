import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { invalidateLedger } from "@/lib/queries";
import { postApproveBulk, type StatementView, statementSettingsQuery } from "./api";

/**
 * まとめて承認（H:§4.5。FR-018）。表示中の未処理の明細のうち、確信度が設定のしきい値以上の候補
 * （候補なしを除く）を承認する。明細ごとに別のトランザクションで、できなかったものは理由つきで残す。
 * しきい値の数字・設定への案内は画面に出さない（「明細の設定」にだけ置く。011 FR-024）。主な操作ではないので outline
 */
export function BulkApprove({
  entityId,
  statements,
}: {
  entityId: string;
  statements: StatementView[];
}) {
  const queryClient = useQueryClient();
  const settings = useQuery(statementSettingsQuery(entityId));
  const threshold = settings.data?.bulkThreshold;
  const eligible =
    threshold === undefined
      ? []
      : statements.filter(
          (s) =>
            s.status === "unprocessed" &&
            s.candidate !== null &&
            s.candidate.method !== "none" &&
            (s.candidate.confidence ?? 0) >= threshold,
        );

  const approve = useMutation({
    mutationFn: ({ ids }: { ids: string[]; contents: Record<string, string> }) =>
      postApproveBulk(
        entityId,
        ids.map((statementId) => ({ statementId })),
      ),
    onSuccess: () => invalidateLedger(queryClient, entityId),
  });
  const result = approve.data;

  return (
    <section aria-label="まとめて承認" className="grid gap-3 rounded-md border px-4 py-3">
      <h2 className="font-medium">まとめて承認</h2>
      <p className="text-sm text-muted-foreground">確信度の高い候補を、案のまま承認します。</p>
      {threshold !== undefined && (
        <p className="text-sm tabular-nums">確信度の高い候補: {eligible.length} 件</p>
      )}
      <div>
        <Button
          variant="outline"
          disabled={eligible.length === 0 || approve.isPending}
          onClick={() =>
            approve.mutate({
              ids: eligible.map((s) => s.id),
              contents: Object.fromEntries(statements.map((s) => [s.id, s.content])),
            })
          }
        >
          まとめて承認
        </Button>
      </div>
      <ApiErrorMessage error={approve.error ?? settings.error} />
      {result && (
        <div className="grid gap-2 text-sm">
          <p role="status">{result.approved.length} 件を承認しました。</p>
          {result.failed.length > 0 && (
            <>
              <p className="font-medium">承認できなかった明細（そのまま残っています）</p>
              <ul aria-label="承認できなかった明細" className="grid gap-1">
                {result.failed.map((f) => (
                  <li
                    key={f.statementId}
                    className="rounded-md border border-destructive/50 px-3 py-1.5"
                  >
                    {approve.variables?.contents[f.statementId] ?? f.statementId}: {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
