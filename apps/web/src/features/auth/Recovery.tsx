import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { registerRecoveryPasskey, verifyRecoveryCode } from "./api";

/**
 * 回復コードでのサインイン（FR-006）。コードの入力 → 回復用の一時セッション（10分）→ 新しいパスキーの登録。
 * 回復コードは登録に成功するまで消費されないので、登録に失敗してもやり直せる
 */
export function Recovery({
  onIssued,
  onCancel,
}: {
  onIssued: (recoveryCode: string) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"code" | "register">("code");
  const [code, setCode] = useState("");

  const verify = useMutation({
    mutationFn: verifyRecoveryCode,
    onSuccess: () => setStep("register"),
  });
  const register = useMutation({
    mutationFn: registerRecoveryPasskey,
    onSuccess: onIssued,
    onError: (error) => {
      // 一時セッションが切れたなら、回復コードの入力からやり直す
      if (error instanceof ApiError && error.status === 401) setStep("code");
    },
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">回復コードでサインイン</h2>
        <p className="text-sm text-muted-foreground">
          回復コードを確認したら、新しいパスキーを登録します。登録に成功すると、使った回復コードは無効になり、新しいコードが表示されます。
        </p>
      </div>
      {step === "code" ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            register.reset();
            verify.mutate(code.trim());
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="recovery-code-input">回復コード</Label>
            <Input
              id="recovery-code-input"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </div>
          <ApiErrorMessage error={verify.error ?? register.error} />
          <Button type="submit" disabled={verify.isPending || code.trim() === ""}>
            確認する
          </Button>
        </form>
      ) : (
        <div className="grid gap-4">
          <p role="status" className="text-sm">
            回復コードを確認しました。10分以内に、新しいパスキーを登録してください。
          </p>
          <ApiErrorMessage error={register.error} />
          <Button disabled={register.isPending} onClick={() => register.mutate()}>
            {register.isPending ? "登録中…" : "新しいパスキーを登録"}
          </Button>
        </div>
      )}
      <Button variant="link" onClick={onCancel}>
        サインインに戻る
      </Button>
    </div>
  );
}
