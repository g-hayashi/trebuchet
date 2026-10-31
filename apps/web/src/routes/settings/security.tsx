import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { authKeys, clearLedgerData, lockVault, regenerateRecoveryKey } from "@/features/auth/api";
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
      <LockCard />
    </main>
  );
}

/** 回復キーの再発行（008 D4.4）。パスキーで再認証してから、新しいキーを一度だけ表示し、保管したと確認する */
function RecoveryCard() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string>();
  const regenerate = useMutation({ mutationFn: regenerateRecoveryKey, onSuccess: setCode });

  return (
    <Card>
      <CardHeader>
        <CardTitle>回復キー</CardTitle>
        <CardDescription>
          作り直すと、古い回復キーは使えなくなります。新しいキーは一度だけ表示されます。作り直す前に、パスキーでもう一度確認します。
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
                回復キーを作り直す
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

/** 施錠（008 D4.5）。全セッションを終え、帳簿を閉じる。解錠にはパスキーか回復キーが要る */
function LockCard() {
  const queryClient = useQueryClient();
  const lockMutation = useMutation({
    mutationFn: lockVault,
    onSuccess: async () => {
      // 帳簿のデータを画面に残さない。認証の状態を取り直すと、AuthGate が解錠の画面にする
      clearLedgerData(queryClient);
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>施錠</CardTitle>
        <CardDescription>
          帳簿を閉じ、すべてのセッションを終えます。解錠にはパスキーか回復キーが要ります。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={lockMutation.error} />
        <div>
          <Button
            variant="outline"
            disabled={lockMutation.isPending}
            onClick={() => lockMutation.mutate()}
          >
            施錠
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
