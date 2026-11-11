/**
 * bench が `app.request` を直接呼ぶときの認証ヘッダー（Host → CSRF の Origin → セッションの Cookie）。
 * `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders` と同じ方法（`issueSession`）で、auth.sqlite に
 * セッションを直接作る（認証の経路は通さない）。scripts から test のファイルは import しない。
 * 呼ぶ前に `useTempDataDir` を使っていること（実データを触らない。テスト用の DK で解錠済みになる）。
 */
import { randomUUIDv7 } from "node:crypto";
import { DEV_WEB_HOST, DEV_WEB_ORIGIN } from "../../apps/server/src/lib/origin.ts";
import { issueSession, SESSION_COOKIE } from "../../apps/server/src/lib/session.ts";
import { DrizzleAuthStore } from "../../packages/db/src/auth-repository.ts";
import { openAuth, openRegistry } from "../../packages/db/src/tenant-store.ts";
import { LOCAL_RP_ID } from "../../packages/domain/src/index.ts";

export async function createBenchHeaders(): Promise<Record<string, string>> {
  if (process.env.TREBUCHET_DATA_DIR === undefined) {
    throw new Error("createBenchHeaders: useTempDataDir を先に呼ぶこと");
  }
  const { token } = await issueSession(new DrizzleAuthStore(openAuth(), openRegistry), {
    id: randomUUIDv7(),
    now: new Date().toISOString(),
    kind: "normal",
    rpId: LOCAL_RP_ID,
    passkeyId: null,
    userAgent: null,
  });
  return { Host: DEV_WEB_HOST, Origin: DEV_WEB_ORIGIN, Cookie: `${SESSION_COOKIE}=${token}` };
}
