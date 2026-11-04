import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { acknowledgeRecoveryKey } from "./api";

/**
 * 回復キーを一度だけ表示する（008 D6）。「保管した」にチェックを入れるまで先に進めない。
 * 進むと acknowledge を呼び、終わってから onDone を呼ぶ。
 * 回復キーは、パスキーを使えなくなったときに帳簿を解錠できる唯一の手段
 */
export function RecoveryCodePanel({
  code,
  onDone,
  secondary = false,
}: {
  code: string;
  onDone: () => void | Promise<void>;
  /** 別の主な操作がある画面（設定のセキュリティ）に置くときは、目立たない見た目にする */
  secondary?: boolean;
}) {
  const checkId = useId();
  const [checked, setChecked] = useState(false);
  const acknowledge = useMutation({
    mutationFn: async () => {
      await acknowledgeRecoveryKey();
      await onDone();
    },
  });

  return (
    <section aria-label="回復キーの保管" className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">回復キー</h2>
        <p className="text-sm text-muted-foreground">
          パスキーを使えなくなったときに、このキーで帳簿を解錠できます。この画面を閉じると二度と表示されません。紙などに書き写して、安全な場所に保管してください。
        </p>
      </div>
      <Input
        aria-label="回復キー"
        readOnly
        value={code}
        onFocus={(event) => event.currentTarget.select()}
        className="select-all text-center font-mono text-lg tracking-wider"
      />
      <div className="flex items-center gap-2 text-sm">
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.currentTarget.checked)}
        />
        <label htmlFor={checkId}>回復キーを安全な場所に保管しました</label>
      </div>
      <ApiErrorMessage error={acknowledge.error} />
      <Button
        variant={secondary ? "outline" : "default"}
        disabled={!checked || acknowledge.isPending}
        onClick={() => acknowledge.mutate()}
      >
        続ける
      </Button>
    </section>
  );
}
