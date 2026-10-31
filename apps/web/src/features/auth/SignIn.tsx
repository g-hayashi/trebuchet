import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { authKeys, unlockWithPasskey } from "./api";

/** パスキーでの解錠（008 D4.2）。成功したら状態を取り直し、AuthGate が帳簿の画面に切り替える */
export function SignIn({ onUseRecovery }: { onUseRecovery: () => void }) {
  const queryClient = useQueryClient();
  const unlock = useMutation({
    mutationFn: unlockWithPasskey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.status }),
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">帳簿は施錠されています</h2>
        <p className="text-sm text-muted-foreground">帳簿はパスキーで解錠するまで読めません。</p>
      </div>
      <ApiErrorMessage error={unlock.error} />
      <Button disabled={unlock.isPending} onClick={() => unlock.mutate()}>
        {unlock.isPending ? "確認中…" : "パスキーで解錠"}
      </Button>
      <Button variant="link" onClick={onUseRecovery}>
        回復キーで解錠
      </Button>
    </div>
  );
}
