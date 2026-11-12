import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { authKeys, clearLedgerData, lockVault } from "./api";

/** 施錠してサインアウトするときの確認の文（011 R17）。セキュリティの画面の施錠も同じ文を使う */
export const SIGN_OUT_CONFIRM_TEXT =
  "すべての端末でサインアウトし、帳簿を閉じます。もう一度開くにはパスキーか回復キーが要ります";

/** ヘッダーの「施錠してサインアウト」。押すと確認のダイアログを出し、確定すると全セッションを終えて施錠する */
export function SignOutButton() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const lock = useMutation({
    mutationFn: lockVault,
    onSuccess: async () => {
      setOpen(false);
      // 帳簿のデータを画面に残さない。認証の状態を取り直すと、AuthGate が解錠の画面にする
      clearLedgerData(queryClient);
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
    },
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          lock.reset();
          setOpen(true);
        }}
      >
        施錠してサインアウト
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="施錠してサインアウト"
        description={SIGN_OUT_CONFIRM_TEXT}
        cancelLabel="やめる"
        confirmLabel="施錠してサインアウト"
        confirmDisabled={lock.isPending}
        onCancel={() => setOpen(false)}
        onConfirm={() => lock.mutate()}
      >
        <ApiErrorMessage error={lock.error} />
      </ConfirmDialog>
    </>
  );
}
