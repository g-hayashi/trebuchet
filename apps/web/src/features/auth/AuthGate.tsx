import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { UNAUTHENTICATED_EVENT } from "@/lib/api";
import { authKeys, authStatusQuery, clearLedgerData, regenerateRecoveryKey } from "./api";
import { Recovery } from "./Recovery";
import { RecoveryCodePanel } from "./RecoveryCodePanel";
import { RegisterPasskey } from "./RegisterPasskey";
import { SignIn } from "./SignIn";

/** 認証の画面の外枠。帳簿のデータを含まない（静的ファイルだけで描ける） */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid max-w-lg gap-6 px-4 py-12">
      <h1 className="text-xl font-semibold">Trebuchet</h1>
      {children}
    </main>
  );
}

/**
 * 認証の状態（GET /api/auth/status）で画面を切り替える（008 D6）。
 * 未設定なら初回の設定、施錠中なら解錠（パスキー・回復キー）、解錠済みなら children。
 * API が 401 UNAUTHENTICATED・LOCKED を返したら（UNAUTHENTICATED_EVENT）帳簿のデータを捨て、
 * 状態を取り直し、解錠の画面に戻る
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const status = useQuery(authStatusQuery());
  // 設定・回復・作り直しで発行された回復キー。保管したと確認するまで、状態が変わっても他の画面に切り替えない
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [mode, setMode] = useState<"sign-in" | "recovery">("sign-in");

  useEffect(() => {
    const onUnauthenticated = () => {
      clearLedgerData(queryClient);
      void queryClient.invalidateQueries({ queryKey: authKeys.status });
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [queryClient]);

  const acknowledged = async () => {
    // 状態を取り直してから切り替える（古い状態のまま設定の画面に戻らないように）
    await queryClient.invalidateQueries({ queryKey: authKeys.status });
    setIssuedCode(null);
    setMode("sign-in");
  };

  if (issuedCode !== null) {
    return (
      <Shell>
        <RecoveryCodePanel code={issuedCode} onDone={acknowledged} />
      </Shell>
    );
  }
  if (status.data === undefined) {
    return (
      <Shell>
        {status.error ? (
          <ApiErrorMessage error={status.error} />
        ) : (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        )}
      </Shell>
    );
  }

  const { registered, signedIn, rpId, recoveryAcknowledged } = status.data;
  if (!registered) {
    return (
      <Shell>
        <RegisterPasskey rpId={rpId} onIssued={setIssuedCode} />
      </Shell>
    );
  }
  if (!signedIn) {
    return (
      <Shell>
        {mode === "recovery" ? (
          <Recovery onIssued={setIssuedCode} onCancel={() => setMode("sign-in")} />
        ) : (
          <SignIn onUseRecovery={() => setMode("recovery")} />
        )}
      </Shell>
    );
  }
  return (
    <>
      {recoveryAcknowledged === false && <RecoveryReminder onIssued={setIssuedCode} />}
      {children}
    </>
  );
}

/** 回復キーを「保管した」と確認していない間、毎回出す案内。全画面の上部に置く */
function RecoveryReminder({ onIssued }: { onIssued: (code: string) => void }) {
  const regenerate = useMutation({ mutationFn: regenerateRecoveryKey, onSuccess: onIssued });
  return (
    <section
      aria-label="回復キーの確認"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <p className="flex-1">
          回復キーを保管したことが確認できていません。キーを作り直して、書き留めてください。
        </p>
        <Button size="sm" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
          回復キーを作り直す
        </Button>
      </div>
      <ApiErrorMessage error={regenerate.error} className="mx-auto max-w-6xl" />
    </section>
  );
}
