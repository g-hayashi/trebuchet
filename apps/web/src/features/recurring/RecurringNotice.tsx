import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { postAcknowledge, recurringKeys, recurringStatusQuery } from "./api";
import { blockedMessage } from "./labels";
import { SkipRunForm } from "./SkipRunForm";

/**
 * 定期仕訳の知らせ（FR-027・028）。事業体の画面の上部に、未確認の自動登録の件数と一覧（「確認した」）、
 * 登録できなかった回と理由（「この回は登録しない」）を出す。どちらもなければ、
 * 状態を読めないとき（読み込み中・エラー）も、画面の邪魔をしないよう何も出さない
 */
export function RecurringNotice({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery(recurringStatusQuery(entityId));
  const acknowledge = useMutation({
    mutationFn: (runIds: string[]) => postAcknowledge(entityId, runIds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recurringKeys.all(entityId) }),
  });
  if (!data || (data.unacknowledged.length === 0 && data.blocked.length === 0)) return null;

  return (
    <section
      aria-label="定期仕訳の知らせ"
      className="mb-4 grid gap-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
    >
      {data.unacknowledged.length > 0 && (
        <div className="grid gap-2">
          <p className="font-medium">
            {`自動で登録した仕訳が ${data.unacknowledged.length} 件あります。`}
          </p>
          <ul className="grid gap-1">
            {data.unacknowledged.map((u) => (
              <li key={u.runId} className="flex flex-wrap items-center gap-2">
                <span>{`${u.name}（${u.targetMonth}）`}</span>
                <Link
                  to="/e/$entityId/journals/$journalId"
                  params={{ entityId, journalId: u.journal.id }}
                  className="underline underline-offset-4"
                >
                  {`仕訳 No.${u.journal.journalNo}`}
                </Link>
                <span className="tabular-nums">{u.journal.date}</span>
              </li>
            ))}
          </ul>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate(data.unacknowledged.map((u) => u.runId))}
            >
              確認した
            </Button>
          </div>
          <ApiErrorMessage error={acknowledge.error} />
        </div>
      )}
      {data.blocked.length > 0 && (
        <div className="grid gap-2">
          <p className="font-medium">{`登録できなかった回が ${data.blocked.length} 件あります。`}</p>
          <ul className="grid gap-3">
            {data.blocked.map((b) => (
              <li key={`${b.recurringId}-${b.targetMonth}`} className="grid gap-1">
                <p>
                  <Link
                    to="/e/$entityId/recurring/$recurringId"
                    params={{ entityId, recurringId: b.recurringId }}
                    className="underline underline-offset-4"
                  >
                    {b.name}
                  </Link>
                  <span>{`（${b.targetMonth}、予定日 ${b.date}）`}</span>
                  {blockedMessage(b.reason, b.details?.code)}
                </p>
                <SkipRunForm
                  entityId={entityId}
                  recurringId={b.recurringId}
                  targetMonth={b.targetMonth}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
