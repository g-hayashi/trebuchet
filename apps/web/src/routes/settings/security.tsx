import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { authKeys, regenerateRecoveryCode, signOut } from "@/features/auth/api";
import { EventList } from "@/features/auth/EventList";
import { PasskeyList } from "@/features/auth/PasskeyList";
import { RecoveryCodePanel } from "@/features/auth/RecoveryCodePanel";
import { SessionList } from "@/features/auth/SessionList";

export const Route = createFileRoute("/settings/security")({
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">セキュリティ</h1>
      <PasskeyList />
      <RecoveryCard />
      <SessionList />
      <EventList />
      <SignOutCard />
    </main>
  );
}

/** 回復コードの再発行（FR-007）。新しいコードを一度だけ表示し、控えたと確認する */
function RecoveryCard() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string>();
  const regenerate = useMutation({ mutationFn: regenerateRecoveryCode, onSuccess: setCode });

  return (
    <Card>
      <CardHeader>
        <CardTitle>回復コード</CardTitle>
        <CardDescription>
          作り直すと、古い回復コードは使えなくなります。新しいコードは一度だけ表示されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {code === undefined ? (
          <>
            <ApiErrorMessage error={regenerate.error} />
            <div>
              <Button
                variant="outline"
                disabled={regenerate.isPending}
                onClick={() => regenerate.mutate()}
              >
                回復コードを作り直す
              </Button>
            </div>
          </>
        ) : (
          <RecoveryCodePanel
            code={code}
            onDone={async () => {
              await queryClient.invalidateQueries({ queryKey: authKeys.status });
              setCode(undefined);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SignOutCard() {
  const queryClient = useQueryClient();
  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      // 帳簿のデータを画面に残さない。認証の状態を取り直すと、AuthGate がサインインの画面にする
      queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== "auth" });
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>サインアウト</CardTitle>
        <CardDescription>この端末のセッションを終えます。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={signOutMutation.error} />
        <div>
          <Button
            variant="outline"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            サインアウト
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
