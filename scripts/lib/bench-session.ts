/**
 * bench が `app.request` を直接呼ぶときの認証ヘッダー（Host → CSRF の Origin → セッションの Cookie）。
 * `apps/server/test/helpers.ts` の `createTestSession`・`testHeaders` と同じ方法で、registry にセッションを
 * 直接作る（認証の経路は通さない）。scripts から test のファイルは import しない。
 * 呼ぶ前に `useTempDataDir` を使っていること（実データの registry を触らない）。
 */
import { randomUUIDv7 } from "node:crypto";
import { issueSession, SESSION_COOKIE } from "../../apps/server/src/lib/session.ts";
import { DrizzleAuthStore } from "../../packages/db/src/auth-repository.ts";
import { openRegistry } from "../../packages/db/src/tenant-store.ts";

/** 許す Host・Origin（Vite の proxy 経由と同じ。ローカルの Host・オリジン） */
export const BENCH_HOST = "localhost:5173";
export const BENCH_ORIGIN = "http://localhost:5173";

export async function createBenchHeaders(): Promise<Record<string, string>> {
  if (process.env.TREBUCHET_DATA_DIR === undefined) {
    throw new Error("createBenchHeaders: useTempDataDir を先に呼ぶこと");
  }
  const { token } = await issueSession(new DrizzleAuthStore(openRegistry()), {
    id: randomUUIDv7(),
    now: new Date().toISOString(),
    kind: "normal",
    rpId: "localhost",
    passkeyId: null,
    userAgent: null,
  });
  return { Host: BENCH_HOST, Origin: BENCH_ORIGIN, Cookie: `${SESSION_COOKIE}=${token}` };
}
