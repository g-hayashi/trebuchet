import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TailscaleStatus } from "@trebuchet/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { remoteKeys, setTailscaleServe, tailscaleStatusQuery } from "./api";

const SERVE_COMMAND = "tailscale serve --bg --https=443 http://127.0.0.1:8787";

function ConnectionLine({ status }: { status: TailscaleStatus }) {
  if (!status.installed) {
    return (
      <p className="text-sm">
        Tailscale はインストールされていません。入れてから、アプリでサインインしてください。
      </p>
    );
  }
  if (!status.running) {
    return (
      <p className="text-sm">
        Tailscale は停止中です。メニューバーのアプリを開いて、サインインして接続してください。
      </p>
    );
  }
  return (
    <p className="text-sm">
      Tailscale に接続中
      {status.dnsName !== null && (
        <>
          ：<strong className="font-medium">{status.dnsName}</strong>
        </>
      )}
    </p>
  );
}

/** Tailscale の状態と、serve（この Mac の帳簿を tailnet に出す）の開始・停止。手動の手順は畳んで残す */
export function TailscaleCard() {
  const queryClient = useQueryClient();
  const query = useQuery(tailscaleStatusQuery());
  const serve = useMutation({
    mutationFn: setTailscaleServe,
    onSuccess: (status) => queryClient.setQueryData(remoteKeys.tailscale, status),
  });
  const status = query.data;
  const canServe = status?.installed === true && status.running && status.dnsName !== null;

  return (
    <Card aria-label="Tailscale">
      <CardHeader>
        <CardTitle>Tailscale</CardTitle>
        <CardDescription>
          スマホなどから、Tailscale の名前（*.ts.net）でこの Mac の帳簿を開けるようにします。Mac
          が解錠されている間だけ使えます。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ApiErrorMessage error={query.error} />
        {query.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
        {status && <ConnectionLine status={status} />}
        {status && canServe && (
          <div className="grid gap-2">
            <p className="text-sm">
              {status.serving ? (
                <>
                  公開中：<code>https://{status.dnsName}</code>
                </>
              ) : (
                "tailnet にはまだ公開していません。"
              )}
            </p>
            <div>
              {status.serving ? (
                <Button
                  variant="outline"
                  disabled={serve.isPending}
                  onClick={() => serve.mutate(false)}
                >
                  停止
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={serve.isPending}
                  onClick={() => serve.mutate(true)}
                >
                  開始
                </Button>
              )}
            </div>
          </div>
        )}
        <ApiErrorMessage error={serve.error} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Funnel は使わない（公開インターネットには出しません）。</li>
          <li>tailnet の中だけで使います。</li>
          <li>Mac が施錠されている間は、ts.net の名前では使えません。先に Mac で解錠します。</li>
        </ul>
        <details className="text-sm">
          <summary className="cursor-pointer">手動で行う場合</summary>
          <div className="mt-2 grid gap-2">
            <p>Mac のターミナルで、次を実行します。</p>
            <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2">
              <code>{SERVE_COMMAND}</code>
            </pre>
            <p>
              止めるときは <code>tailscale serve --https=443 off</code> です。
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
