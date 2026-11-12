import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoteSettings } from "@trebuchet/schema";
import { useId, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SaveNotice } from "@/components/ui/save-notice";
import { authKeys, authStatusQuery, LOCAL_RP_ID } from "../auth/api";
import { putRemoteSettings, remoteKeys, remoteSettingsQuery, tailscaleStatusQuery } from "./api";

function Fields({ settings }: { settings: RemoteSettings }) {
  const id = useId();
  const queryClient = useQueryClient();
  const dnsName = useQuery(tailscaleStatusQuery()).data?.dnsName ?? null;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [host, setHost] = useState(settings.host ?? "");
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: putRemoteSettings,
    onSuccess: async (saved) => {
      queryClient.setQueryData(remoteKeys.settings, saved);
      setNotice("保存しました。");
      // 状態の `remote`（ペアリングの案内が読む）と、認証の記録が変わる
      await queryClient.invalidateQueries({ queryKey: authKeys.status });
      await queryClient.invalidateQueries({ queryKey: authKeys.events });
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice("");
        save.reset();
        const trimmed = host.trim();
        save.mutate({ enabled, host: trimmed === "" ? null : trimmed });
      }}
    >
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
        {dnsName !== null && host.trim() !== dnsName && (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setHost(dnsName)}>
              この Mac の名前を入れる
            </Button>
          </div>
        )}
      </div>
      <ApiErrorMessage error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        <SaveNotice message={notice} />
      </div>
    </form>
  );
}

/**
 * リモート（Tailscale）の設定（FR-010・011）。保存のあと、Host の検査は再起動なしで変わる。
 * 変更は Mac の localhost からだけできる（server は ts.net の Host からを 421 にする）。
 * ts.net の名前で開いているときは、保存の欄を出さずにその旨を案内する
 */
export function RemoteSettingsForm() {
  const settings = useQuery(remoteSettingsQuery());
  const status = useQuery(authStatusQuery());
  const local = status.data?.rpId === LOCAL_RP_ID;
  return (
    <Card aria-label="リモートの設定">
      <CardHeader>
        <CardTitle>リモートの設定</CardTitle>
        <CardDescription>
          有効にして名前を保存すると、その名前（*.ts.net）での接続を受け付けます。保存のあと、再起動は要りません。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {settings.error && <ApiErrorMessage error={settings.error} />}
        <ApiErrorMessage error={status.error} />
        {(settings.isPending || status.isPending) && <Loading />}
        {status.data && !local && (
          <p className="text-sm text-muted-foreground">
            リモートの設定の変更は、この Mac（localhost）で操作してください。ts.net
            の名前で開いているときは変更できません。
          </p>
        )}
        {settings.data && local && <Fields settings={settings.data} />}
      </CardContent>
    </Card>
  );
}
