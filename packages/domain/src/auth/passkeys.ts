import type { Passkey } from "./types.ts";

/** ローカル（`localhost`）の RP ID */
export const LOCAL_RP_ID = "localhost";

/**
 * パスキーを削除してよいか（data-model §1.1）。
 * `localhost` のパスキーの最後の 1 つだけは削除できない（ローカルで入れなくなるため）。
 * ts.net の名前のものは全部消せる。存在しない id は false。
 */
export function canDeletePasskey(
  passkeys: readonly Pick<Passkey, "id" | "rpId">[],
  id: string,
): boolean {
  const target = passkeys.find((p) => p.id === id);
  if (!target) return false;
  if (target.rpId !== LOCAL_RP_ID) return true;
  return passkeys.filter((p) => p.rpId === LOCAL_RP_ID).length > 1;
}
