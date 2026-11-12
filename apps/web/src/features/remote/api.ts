import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { registerWith, withReauth } from "../auth/api";

// リモート（Tailscale）の設定とペアリングの API（004 contracts/http-api.md の `/settings/remote`・`/auth/pairing`）

const remote = api.api.settings.remote;
const pairing = api.api.auth.pairing;

export const remoteKeys = {
  settings: ["settings", "remote"] as const,
  tailscale: ["settings", "remote", "tailscale"] as const,
};

/** tailscale の CLI から読んだ状態（Mac のローカルの Host だけ。それ以外は 421） */
export const tailscaleStatusQuery = () =>
  queryOptions({
    queryKey: remoteKeys.tailscale,
    queryFn: async () => unwrap(await remote.tailscale.$get()),
  });

/** serve の開始・停止。実行後の状態を返す（見つからなければ 503、コマンドの失敗は 502） */
export const setTailscaleServe = async (enabled: boolean) =>
  unwrap(await remote.tailscale.serve.$put({ json: { enabled } }));

export const remoteSettingsQuery = () =>
  queryOptions({
    queryKey: remoteKeys.settings,
    queryFn: async () => unwrap(await remote.$get()),
  });

/**
 * 保存する。直近 5 分以内の再認証が要る（なければパスキーで確認してからやり直す）。
 * 名前が `*.ts.net` の形でなければ 422 REMOTE_HOST_INVALID
 */
export const putRemoteSettings = (json: { enabled: boolean; host: string | null }) =>
  withReauth(async () => unwrap(await remote.$put({ json })));

/**
 * ペアリングの URL を発行する（Mac から。直近 5 分以内の再認証が要る。なければ確認してからやり直す）。
 * URL は一度だけ・10 分有効。応答のトークンは画面に出す以外に使わない
 */
export const issuePairing = () => withReauth(async () => unwrap(await pairing.$post()));

/**
 * ペアリングの URL を開いたスマホで、この名前のパスキーを登録する。
 * PRF の出力が返らなければ認証をもう一度行い、同じ verify に送る（`registerWith`）
 */
export const registerPairedPasskey = (token: string) =>
  registerWith(
    async () => pairing.register.options.$post({ json: { token } }),
    async (input) => unwrap(await pairing.register.verify.$post({ json: { token, ...input } })),
  );
