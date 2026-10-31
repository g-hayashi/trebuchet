import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { ApiError } from "@/lib/api";
import { authKeys, registerFirstPasskey } from "./api";

const LOCAL_RP_ID = "localhost";

/** 初回の設定（008 D4.1）。設定は Mac のローカルの名前（localhost）からだけ。判定は server に従う */
export function RegisterPasskey({
  rpId,
  onIssued,
}: {
  rpId: string;
  onIssued: (recoveryCode: string) => void;
}) {
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: registerFirstPasskey,
    onSuccess: onIssued,
    onError: (error) => {
      // すでに設定されていたなら、状態を取り直して解錠の画面に進む
      if (error instanceof ApiError && error.code === "ALREADY_REGISTERED") {
        void queryClient.invalidateQueries({ queryKey: authKeys.status });
      }
    },
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">初回の設定</h2>
        <p className="text-sm text-muted-foreground">
          帳簿はパスキーで暗号化して保存します。パスキーを作ると、回復キーが表示されます。パスキーは、PRF
          に対応したもの（iCloud キーチェーン、1Password など）を使ってください。
        </p>
      </div>
      {rpId === LOCAL_RP_ID ? (
        <>
          <ApiErrorMessage error={register.error} />
          <Button disabled={register.isPending} onClick={() => register.mutate()}>
            {register.isPending ? "作成中…" : "パスキーを作成"}
          </Button>
        </>
      ) : (
        <p role="status" className="rounded-md border px-3 py-2 text-sm">
          最初の設定は、Mac のローカルの名前（localhost）で開いて設定してください。この接続先（
          {rpId}）からは設定できません。
        </p>
      )}
    </div>
  );
}
