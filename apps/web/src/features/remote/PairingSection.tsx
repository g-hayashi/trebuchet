import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { authKeys, authStatusQuery, passkeysQuery } from "../auth/api";
import { issuePairing } from "./api";

const LOCAL_RP_ID = "localhost";

/** URL の QR コード。SVG は uqr の出力だけを入れる（URL の文字列そのものは HTML にしない） */
function PairingQr({ url }: { url: string }) {
  return (
    <div
      role="img"
      aria-label="ペアリングの QR コード"
      className="size-44 shrink-0 rounded-md border bg-white p-2 [&>svg]:size-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: uqr が生成した SVG の文字列だけを入れる
      dangerouslySetInnerHTML={{ __html: renderSVG(url) }}
    />
  );
}

/**
 * ペアリング（FR-012）。ts.net の名前で使うパスキーを、スマホなどで登録する URL を発行する。
 * 発行できるのは、localhost でサインイン中・リモートが有効・名前が登録済みのとき。
 * その名前のパスキーがすでにあっても、本数を示して追加できる。発行は再認証つき
 * （サーバーが 403 を返したら確認してやり直す）。URL は一度だけ・10 分有効で、画面を離れると二度と表示されない
 */
export function PairingSection() {
  const queryClient = useQueryClient();
  const status = useQuery(authStatusQuery()).data;
  const passkeys = useQuery(passkeysQuery()).data;
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
    host !== null;
  const registered = host === null ? 0 : (passkeys?.filter((p) => p.rpId === host).length ?? 0);

  const issued = issue.data;
  return (
    <Card aria-label="ペアリング">
      <CardHeader>
        <CardTitle>ペアリング</CardTitle>
        <CardDescription>
          スマホなどで ts.net の名前を開くためのパスキーは、ペアリングの URL
          からだけ登録できます。発行の前に、パスキーでもう一度確認します。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">
            この Mac（localhost）でサインインし、上でリモートを有効にして名前を保存すると、ここで
            URL を発行できます。
          </p>
        ) : (
          <>
            <div className="grid gap-1 text-sm">
              <p className="font-medium">{host} で使うパスキー</p>
              {registered > 0 ? (
                <p>登録済み（{registered} 本）</p>
              ) : (
                <p className="text-muted-foreground">まだ登録されていません。</p>
              )}
            </div>
            <ApiErrorMessage error={issue.error} />
            <div>
              <Button variant="outline" disabled={issue.isPending} onClick={() => issue.mutate()}>
                この名前で使うパスキーを追加（ペアリング）
              </Button>
            </div>
            {issued && (
              <section aria-label="ペアリングの URL" className="grid gap-3 sm:grid-cols-[auto_1fr]">
                <PairingQr url={issued.url} />
                <div className="grid content-start gap-2">
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
                    iPhone のカメラで QR を読むと開けます。iCloud
                    キーチェーンなどの同期されるパスキーで登録すれば、同じアカウントのほかの端末でもそのまま使えます（端末ごとのペアリングは要りません）。
                  </p>
                  <p className="text-sm text-muted-foreground">
                    有効期限は 10 分（{formatDateTime(issued.expiresAt)}{" "}
                    まで）で、一度だけ使えます。この画面を閉じると、URL と QR
                    は二度と表示されません。
                  </p>
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
