import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { ApiError } from "@/lib/api";
import { registerPairedPasskey } from "../remote/api";
import { authKeys } from "./api";

const INVALID_MESSAGE = "ペアリングの URL が無効か期限切れです。Mac でもう一度発行してください";

/** この画面だけの文言があるエラー。それ以外（検証の失敗など）は共通の文言（`ApiErrorMessage`）に任せる */
function pairMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case "PAIRING_TOKEN_INVALID":
      return INVALID_MESSAGE;
    case "LOCKED":
      return "Mac でアプリを解錠してください。解錠してから、もう一度お試しください。";
    case "PRF_UNSUPPORTED":
      return "この端末のパスキーは鍵の保護（PRF）に対応していません。iCloud キーチェーンや 1Password などの PRF に対応したパスキーで、もう一度お試しください。";
    default:
      return undefined;
  }
}

function PairError({ error }: { error: unknown }) {
  const message = error ? pairMessage(error) : undefined;
  if (message === undefined) return <ApiErrorMessage error={error} />;
  return (
    <div aria-live="assertive">
      <p
        role="alert"
        className="rounded-md border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive"
      >
        {message}
      </p>
    </div>
  );
}

/**
 * ペアリングの URL（`/pair?token=…`）を開いたスマホの画面（004/FR-012）。サインインなしで開く（`__root` の例外）。
 * パスキーの作成には利用者の操作が要るので、ボタンで始める。成功すると server がセッションを始めているので、帳簿へ進む
 */
export function Pair({ token }: { token: string | undefined }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const register = useMutation({
    mutationFn: (value: string) => registerPairedPasskey(value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
      await navigate({ to: "/", replace: true });
    },
  });

  return (
    <main className="mx-auto grid max-w-lg gap-6 px-4 py-12">
      <h1 className="text-xl font-semibold">Trebuchet</h1>
      <div className="grid gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">このスマホのパスキーを登録</h2>
          <p className="text-sm text-muted-foreground">
            Mac で発行したペアリングの URL です。パスキーは、PRF に対応したもの（iCloud
            キーチェーン、1Password など）を使ってください。
          </p>
        </div>
        {token === undefined || token === "" ? (
          <p role="alert" className="rounded-md border px-3 py-2 text-sm">
            {INVALID_MESSAGE}
          </p>
        ) : (
          <>
            <PairError error={register.error} />
            <Button disabled={register.isPending} onClick={() => register.mutate(token)}>
              {register.isPending ? "登録中…" : "このスマホのパスキーを登録"}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
