import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { postSkipRun, recurringKeys } from "./api";

/**
 * 「この回は登録しない」（005/FR-027）。登録できなかった回・未登録の回を、理由つきで確定する。
 * 理由が空かどうかの検査は server（`REASON_REQUIRED`）が行う
 */
export function SkipRunForm({
  entityId,
  recurringId,
  targetMonth,
}: {
  entityId: string;
  recurringId: string;
  targetMonth: string;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const skip = useMutation({
    mutationFn: () => postSkipRun(entityId, recurringId, targetMonth, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: recurringKeys.all(entityId) }),
  });

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        この回は登録しない
      </Button>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    skip.mutate();
  };

  return (
    <form
      noValidate
      aria-label={`${targetMonth} の回を登録しない`}
      className="grid gap-2"
      onSubmit={onSubmit}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={`${id}-reason`} className="text-sm">
          理由
        </label>
        <Input
          id={`${id}-reason`}
          autoComplete="off"
          className="w-64"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={skip.isPending}>
          登録しない
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          やめる
        </Button>
      </div>
      <ApiErrorMessage error={skip.error} />
    </form>
  );
}
