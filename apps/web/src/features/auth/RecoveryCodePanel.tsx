import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { acknowledgeRecoveryCode } from "./api";

/**
 * 回復コードを一度だけ表示する（FR-002・007）。「控えた」にチェックを入れるまで先に進めない。
 * 進むと acknowledge を呼び、終わってから onDone を呼ぶ
 */
export function RecoveryCodePanel({
  code,
  onDone,
}: {
  code: string;
  onDone: () => void | Promise<void>;
}) {
  const checkId = useId();
  const [checked, setChecked] = useState(false);
  const acknowledge = useMutation({
    mutationFn: async () => {
      await acknowledgeRecoveryCode();
      await onDone();
    },
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">回復コード</h2>
        <p className="text-sm text-muted-foreground">
          パスキーを使えなくなったときに、このコードでサインインできます。この画面を閉じると二度と表示されません。紙などに書き写して、安全な場所に保管してください。
        </p>
      </div>
      <p
        className="select-all rounded-md border bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider"
        data-testid="recovery-code"
      >
        {code}
      </p>
      <div className="flex items-center gap-2 text-sm">
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.currentTarget.checked)}
        />
        <label htmlFor={checkId}>回復コードを控えた</label>
      </div>
      <ApiErrorMessage error={acknowledge.error} />
      <Button disabled={!checked || acknowledge.isPending} onClick={() => acknowledge.mutate()}>
        続ける
      </Button>
    </div>
  );
}
