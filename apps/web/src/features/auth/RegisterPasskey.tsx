import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import { registerFirstPasskey } from "./api";

const LOCAL_RP_ID = "localhost";

/** 初回の登録（FR-001）。登録は Mac のローカルの名前（localhost）からだけ。判定はサーバーに従う */
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
      // すでに登録されていたなら、状態を取り直してサインインの画面に進む
      if (error instanceof ApiError && error.code === "ALREADY_REGISTERED") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
      }
    },
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">パスキーの登録</h2>
        <p className="text-sm text-muted-foreground">
          帳簿を守るため、最初にパスキーを登録します。登録すると回復コードが表示されます。
        </p>
      </div>
      {rpId === LOCAL_RP_ID ? (
        <>
          <ApiErrorMessage error={register.error} />
          <Button disabled={register.isPending} onClick={() => register.mutate()}>
            {register.isPending ? "登録中…" : "パスキーを登録"}
          </Button>
        </>
      ) : (
        <p role="status" className="rounded-md border px-3 py-2 text-sm">
          最初の登録は、Mac のローカルの名前（localhost）で開いて登録してください。この接続先（
          {rpId}）からは登録できません。
        </p>
      )}
    </div>
  );
}
