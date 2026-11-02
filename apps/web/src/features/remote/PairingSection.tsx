import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { authKeys, authStatusQuery } from "../auth/api";
import { issuePairing } from "./api";

const LOCAL_RP_ID = "localhost";

/**
 * パスキーの一覧の中の、ペアリングの案内（FR-012）。localhost でサインイン中・リモートが有効・
 * 名前が登録済み・その名前のパスキーがまだ無いときだけ出る。発行は再認証つき（サーバーが 403 を返したら確認してやり直す）。
 * URL は一度だけ・10 分有効で、画面を離れると二度と表示されない
 */
export function PairingSection({ passkeyRpIds }: { passkeyRpIds: readonly string[] }) {
  const queryClient = useQueryClient();
  const status = useQuery(authStatusQuery()).data;
  const [copied, setCopied] = useState(false);
  const issue = useMutation({
    mutationFn: issuePairing,
    onSuccess: async () => {
      setCopied(false);
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });

  const host = status?.remote.host ?? null;
  const available =
    status !== undefined &&
    status.rpId === LOCAL_RP_ID &&
    status.signedIn &&
    status.remote.enabled &&
    host !== null &&
    !passkeyRpIds.includes(host);
  if (!available) return null;

  const issued = issue.data;
  return (
    <section aria-label="ペアリング" className="grid gap-3 rounded-md border p-4">
      <div className="grid gap-1">
        <h3 className="font-medium">{host} で使うパスキー</h3>
        <p className="text-sm text-muted-foreground">
          スマホなどで {host} を開くためのパスキーは、ペアリングの URL
          からだけ登録できます。発行の前に、パスキーでもう一度確認します。
        </p>
      </div>
      <ApiErrorMessage error={issue.error} />
      <div>
        <Button variant="outline" disabled={issue.isPending} onClick={() => issue.mutate()}>
          この名前で使うパスキーを追加（ペアリング）
        </Button>
      </div>
      {issued && (
        <section aria-label="ペアリングの URL" className="grid gap-2">
          <Label htmlFor="pairing-url">ペアリングの URL</Label>
          <div className="flex gap-2">
            <Input
              id="pairing-url"
              readOnly
              value={issued.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.url);
                setCopied(true);
              }}
            >
              URL をコピー
            </Button>
          </div>
          {copied && (
            <p role="status" className="text-sm">
              コピーしました。
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            有効期限は 10 分（{formatDateTime(issued.expiresAt)}{" "}
            まで）で、一度だけ使えます。スマホで開いて、パスキーを登録してください。この画面を閉じると、URL
            は二度と表示されません。
          </p>
        </section>
      )}
    </section>
  );
}
