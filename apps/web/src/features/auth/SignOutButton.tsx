import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>施錠してサインアウト</DialogTitle>
            <DialogDescription>{SIGN_OUT_CONFIRM_TEXT}</DialogDescription>
          </DialogHeader>
          <ApiErrorMessage error={lock.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              やめる
            </Button>
            <Button disabled={lock.isPending} onClick={() => lock.mutate()}>
              施錠してサインアウト
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
