import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { queryKeys } from "@/lib/queries";
import { signIn } from "./api";

/** パスキーでのサインイン（FR-003）。成功したら状態を取り直し、AuthGate が帳簿の画面に切り替える */
export function SignIn({ onUseRecovery }: { onUseRecovery: () => void }) {
  const queryClient = useQueryClient();
  const signInMutation = useMutation({
    mutationFn: signIn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.authStatus }),
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">サインイン</h2>
        <p className="text-sm text-muted-foreground">パスキーで本人を確認します。</p>
      </div>
      <ApiErrorMessage error={signInMutation.error} />
      <Button disabled={signInMutation.isPending} onClick={() => signInMutation.mutate()}>
        {signInMutation.isPending ? "確認中…" : "パスキーでサインイン"}
      </Button>
      <Button variant="link" onClick={onUseRecovery}>
        回復コードを使う
      </Button>
    </div>
  );
}
