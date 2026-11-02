import { LOCAL_RP_ID } from "@trebuchet/domain";

/**
 * 許す Host・オリジン・RP ID の決定（research R2・R6）。ほかのコードはここを通す。
 * 純粋な関数だけ。リモートの設定（auth.sqlite の remote_settings。`AuthStore.getRemoteSettings`）は引数で受ける
 */

/** リモート（Tailscale）の設定。既定は無効。読み込みは T016 が足す */
export type RemoteSettings = { enabled: boolean; host: string | null };
export type GetRemoteSettings = () => Promise<RemoteSettings>;

const REMOTE_DISABLED: RemoteSettings = { enabled: false, host: null };
export const getRemoteSettingsDisabled: GetRemoteSettings = async () => REMOTE_DISABLED;

/** 開発の画面（Vite の proxy 経由）の Host とオリジン。テストと bench が要求に付ける値もこれ */
export const DEV_WEB_HOST = "localhost:5173";
export const DEV_WEB_ORIGIN = `http://${DEV_WEB_HOST}`;

/**
 * ローカルの Host（Vite の proxy 経由と server への直接）。
 * `127.0.0.1:8787` はヘルスチェックと E2E の server の起動確認だけに使う（RP ID は持たない）
 */
const LOCAL_RP_HOSTS: readonly string[] = [DEV_WEB_HOST, "localhost:8787"];
const LOCAL_HOSTS: readonly string[] = [...LOCAL_RP_HOSTS, "127.0.0.1:8787"];

/**
 * 要求の接続先の名前を取り出す、唯一の場所。今は `Host` ヘッダーだけを見る。
 * Tailscale の `serve` の転送で届く名前（`Host` か `X-Forwarded-Host` か）は T001(b) の確認の後、
 * T016 でここだけを直して決める
 */
export function requestHost(req: { header(name: string): string | undefined }): string | undefined {
  return req.header("host");
}

function normalize(host: string | undefined): string | undefined {
  const h = host?.trim().toLowerCase();
  return h === undefined || h === "" ? undefined : h;
}

/** リモートが有効で名前が登録されているときの、その名前（小文字） */
function remoteName(remote: RemoteSettings): string | undefined {
  return remote.enabled ? normalize(remote.host ?? undefined) : undefined;
}

export function isLocalHost(host: string | undefined): boolean {
  const h = normalize(host);
  return h !== undefined && LOCAL_HOSTS.includes(h);
}

export function isAllowedHost(
  host: string | undefined,
  remote: RemoteSettings = REMOTE_DISABLED,
): boolean {
  const h = normalize(host);
  if (h === undefined) return false;
  return LOCAL_HOSTS.includes(h) || h === remoteName(remote);
}

/** 状態を変える要求の `Origin` として許す一覧（ローカルは http、ts.net の名前は https） */
export function allowedOrigins(remote: RemoteSettings = REMOTE_DISABLED): string[] {
  const origins = LOCAL_RP_HOSTS.map((h) => `http://${h}`);
  const name = remoteName(remote);
  if (name !== undefined) origins.push(`https://${name}`);
  return origins;
}

/** パスキーの RP ID。`localhost` か登録した ts.net の名前。それ以外は undefined */
export function rpIdFor(
  host: string | undefined,
  remote: RemoteSettings = REMOTE_DISABLED,
): string | undefined {
  const h = normalize(host);
  if (h === undefined) return undefined;
  if (LOCAL_RP_HOSTS.includes(h)) return LOCAL_RP_ID;
  return h === remoteName(remote) ? h : undefined;
}

/** WebAuthn の応答の検証で期待する origin */
export function expectedOriginFor(
  host: string | undefined,
  remote: RemoteSettings = REMOTE_DISABLED,
): string | undefined {
  const h = normalize(host);
  if (h === undefined) return undefined;
  if (LOCAL_RP_HOSTS.includes(h)) return `http://${h}`;
  return h === remoteName(remote) ? `https://${h}` : undefined;
}
