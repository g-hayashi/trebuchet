import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoteSettings } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { authKeys } from "../auth/api";
import { putRemoteSettings, remoteKeys, remoteSettingsQuery } from "./api";

const SERVE_COMMAND = "tailscale serve --bg --https=443 http://127.0.0.1:8787";

function Fields({ settings }: { settings: RemoteSettings }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [host, setHost] = useState(settings.host ?? "");
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: putRemoteSettings,
    onSuccess: async (saved) => {
      queryClient.setQueryData(remoteKeys.settings, saved);
      setNotice("保存しました。");
      // 状態の `remote`（パスキーの一覧のペアリングの案内が読む）と、認証の記録が変わる
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });

  return (
    <form
      noValidate
      aria-label="リモートの設定"
      className="grid max-w-xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice("");
        save.reset();
        const trimmed = host.trim();
        save.mutate({ enabled, host: trimmed === "" ? null : trimmed });
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Tailscale からの利用</CardTitle>
          <CardDescription>
            スマホなどから、Tailscale の名前（*.ts.net）でこの Mac の帳簿を開けるようにします。Mac
            が解錠されている間だけ使えます。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-enabled`}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
            <label htmlFor={`${id}-enabled`}>リモートを有効にする</label>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-host`}>ts.net の名前</Label>
            <Input
              id={`${id}-host`}
              autoComplete="off"
              placeholder="mac.tail1234.ts.net"
              value={host}
              onChange={(event) => setHost(event.currentTarget.value)}
            />
          </div>
          <ApiErrorMessage error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
            <SaveNotice message={notice} />
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

function Guide() {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>手順と注意</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Mac のターミナルで、次を実行します。
            <pre className="mt-1 overflow-x-auto rounded-md border bg-muted px-3 py-2">
              <code>{SERVE_COMMAND}</code>
            </pre>
            止めるときは <code>tailscale serve reset</code> です。
          </li>
          <li>上の欄に、Tailscale の名前（*.ts.net）を入れて、有効にして保存します。</li>
          <li>
            「セキュリティ」のパスキーの一覧で「この名前で使うパスキーを追加（ペアリング）」を押し、表示された
            URL をスマホで開いてパスキーを登録します。
          </li>
        </ol>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Funnel は使わない（公開インターネットには出しません）。</li>
          <li>tailnet の中だけで使います。</li>
          <li>Mac が施錠されている間は、ts.net の名前では使えません。先に Mac で解錠します。</li>
        </ul>
      </CardContent>
    </Card>
  );
}

/** リモート（Tailscale）の設定（FR-010・011）。保存のあと、Host の検査は再起動なしで変わる */
export function RemoteSettingsForm() {
  const settings = useQuery(remoteSettingsQuery());
  return (
    <div className="grid gap-6">
      {settings.error && <ApiErrorMessage error={settings.error} />}
      {settings.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {settings.data && <Fields settings={settings.data} />}
      <Guide />
    </div>
  );
}
