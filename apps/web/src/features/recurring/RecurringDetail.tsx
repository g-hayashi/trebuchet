import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RecurringDetailResponse } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { thisMonth } from "@/lib/dates";
import { invalidateLedger } from "@/lib/queries";
import { confirmDetailsOf, postPause, postResume, recurringKeys } from "./api";
import { blockedMessage, dayLabel, periodLabel, STATUS_LABELS } from "./labels";
import { RecurringForm } from "./RecurringForm";
import { SkipRunForm } from "./SkipRunForm";

const RUN_STATUS_LABELS = { posted: "登録済み", skipped: "登録しない" } as const;

/**
 * 定期仕訳の詳細（FR-023・026〜029）。停止・再開（再開の月と、今日以前に登録される回の確認）、
 * 登録できなかった回（「この回は登録しない」）、内容の編集、登録の記録
 */
export function RecurringDetail({
  entityId,
  detail,
}: {
  entityId: string;
  detail: RecurringDetailResponse;
}) {
  const { recurring, runs, blocked } = detail;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-muted-foreground">
        {`${dayLabel(recurring.dayOfMonth)} ／ ${periodLabel(recurring.startMonth, recurring.endMonth)} ／ ${STATUS_LABELS[recurring.status]}`}
      </p>
      <Actions entityId={entityId} recurring={recurring} />
      {blocked.length > 0 && (
        <section aria-label="登録できなかった回" className="grid gap-3">
          <h2 className="text-base font-semibold">登録できなかった回</h2>
          <ul className="grid gap-3">
            {blocked.map((b) => (
              <li key={b.targetMonth} className="grid gap-1 rounded-md border p-3 text-sm">
                <p>
                  <span className="tabular-nums">{`${b.targetMonth}（予定日 ${b.date}）`}</span>{" "}
                  {blockedMessage(b.reason, b.details?.code)}
                </p>
                <SkipRunForm
                  entityId={entityId}
                  recurringId={recurring.id}
                  targetMonth={b.targetMonth}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="内容" className="grid gap-3">
        <h2 className="text-base font-semibold">内容の変更</h2>
        <RecurringForm key={recurring.version} entityId={entityId} recurring={recurring} />
      </section>
      <section aria-label="登録の記録" className="grid gap-3">
        <h2 className="text-base font-semibold">登録の記録</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">登録の記録はまだありません。</p>
        ) : (
          <Table aria-label="登録の記録">
            <TableHeader>
              <TableRow>
                <TableHead>対象月</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>仕訳・理由</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.targetMonth}>
                  <TableCell className="tabular-nums">{r.targetMonth}</TableCell>
                  <TableCell>{RUN_STATUS_LABELS[r.status]}</TableCell>
                  <TableCell>
                    {r.journalId !== null && (
                      <Link
                        to="/e/$entityId/journals/$journalId"
                        params={{ entityId, journalId: r.journalId }}
                        className="text-primary underline underline-offset-4"
                      >
                        仕訳を開く
                      </Link>
                    )}
                    {r.skipReason}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

/** 停止と再開。再開の月の既定は今日の月。確認が要るときは件数を示して `confirm: true` で再送する */
function Actions({
  entityId,
  recurring,
}: {
  entityId: string;
  recurring: RecurringDetailResponse["recurring"];
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [fromMonth, setFromMonth] = useState(thisMonth);
  const [confirming, setConfirming] = useState<{ count: number; months: string[] }>();

  const refresh = async (posted: number) => {
    setConfirming(undefined);
    await (posted > 0
      ? invalidateLedger(queryClient, entityId)
      : queryClient.invalidateQueries({ queryKey: recurringKeys.all(entityId) }));
  };

  const pause = useMutation({
    mutationFn: () => postPause(entityId, recurring.id, recurring.version),
    onSuccess: () => refresh(0),
  });
  const resume = useMutation({
    mutationFn: (confirm: boolean) =>
      postResume(entityId, recurring.id, {
        version: recurring.version,
        fromMonth,
        ...(confirm ? { confirm: true } : {}),
      }),
    onSuccess: (result) => refresh(result.posted.length),
    onError: (e) => setConfirming(confirmDetailsOf(e)),
  });
  // 確認の表示にした 409 は、エラーとしては出さない
  const resumeError = confirmDetailsOf(resume.error) ? undefined : resume.error;

  if (recurring.status === "active") {
    return (
      <div className="grid gap-2">
        <div>
          <Button variant="outline" disabled={pause.isPending} onClick={() => pause.mutate()}>
            停止する
          </Button>
        </div>
        <ApiErrorMessage error={pause.error} />
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-from`}>再開の月</Label>
          <Input
            id={`${id}-from`}
            type="month"
            value={fromMonth}
            onChange={(e) => {
              setFromMonth(e.target.value);
              setConfirming(undefined);
            }}
          />
        </div>
        <Button
          disabled={resume.isPending || fromMonth === ""}
          onClick={() => {
            setConfirming(undefined);
            resume.mutate(false);
          }}
        >
          再開する
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        再開の月より前の回は登録しません（停止の間の月を登録しません）。
      </p>
      {confirming && (
        <div
          role="alert"
          className="grid gap-3 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-950"
        >
          <p>
            {`今日までに登録される回が ${confirming.count} 件あります（${confirming.months.join("、")}）。再開すると、これらの仕訳をすぐに登録します。`}
          </p>
          <div>
            <Button disabled={resume.isPending} onClick={() => resume.mutate(true)}>
              確認して再開する
            </Button>
          </div>
        </div>
      )}
      <ApiErrorMessage error={resumeError} />
    </div>
  );
}
