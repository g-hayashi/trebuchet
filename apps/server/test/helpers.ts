import { randomBytes, randomUUIDv7 } from "node:crypto";
import { DrizzleAuthStore, hashToken, openRegistry } from "@trebuchet/db";
import type { SessionKind } from "@trebuchet/domain";
import { testClient } from "hono/testing";
import { app as realApp } from "../src/app.ts";
import { SESSION_COOKIE } from "../src/lib/session.ts";

/** テストが使う接続先（Vite の proxy 経由と同じ。ローカルの Host・オリジン） */
export const TEST_HOST = "localhost:5173";
export const TEST_ORIGIN = "http://localhost:5173";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export type TestSessionOptions = {
  kind?: SessionKind;
  rpId?: string;
  passkeyId?: string | null;
  /** createdAt と lastSeenAt（既定は今）。期限切れのセッションを作るときに過去を渡す */
  now?: string;
};

export type TestSession = { id: string; token: string; cookie: string };

/**
 * registry にセッションを直接作る（認証の経路は通さない。R15）。
 * 呼ぶ前に useTempDataDir を使っていること（実データの registry を触らない）
 */
export async function createTestSession(opts: TestSessionOptions = {}): Promise<TestSession> {
  if (process.env.TREBUCHET_DATA_DIR === undefined) {
    throw new Error("createTestSession: useTempDataDir を先に呼ぶこと");
  }
  const token = randomBytes(32).toString("base64url");
  const id = randomUUIDv7();
  await new DrizzleAuthStore(openRegistry()).createSession({
    id,
    tokenHash: hashToken(token),
    kind: opts.kind ?? "normal",
    rpId: opts.rpId ?? "localhost",
    passkeyId: opts.passkeyId ?? null,
    userAgent: null,
    now: opts.now ?? new Date().toISOString(),
  });
  return { id, token, cookie: `${SESSION_COOKIE}=${token}` };
}

/** データの置き場所（一時のもの）ごとの既定のセッション */
const defaultSessions = new Map<string, TestSession>();

async function defaultSession(): Promise<TestSession> {
  const dir = process.env.TREBUCHET_DATA_DIR ?? "";
  const cached = defaultSessions.get(dir);
  if (cached) return cached;
  const created = await createTestSession();
  defaultSessions.set(dir, created);
  return created;
}

/** 許す Host・Origin と、有効なセッションの Cookie */
export async function testHeaders(): Promise<Record<string, string>> {
  const session = await defaultSession();
  return { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: session.cookie };
}

/**
 * `app.request` と同じ形で、許す Host・Origin・セッションの Cookie を既定で付ける。
 * 呼び出し側が同じヘッダーを渡したときは、そちらを優先する
 */
export const app = {
  async request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await testHeaders())) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return realApp.request(path, { ...init, headers });
  },
};

export const client = testClient(realApp, undefined, undefined, { headers: testHeaders });

/** テスト用の事業体を作成し、その ID を返す */
export async function createTestEntity(name = "個人事業"): Promise<string> {
  const res = await client.api.entities.$post({
    json: { name, kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  const body = await res.json();
  return body.entity.id;
}

export async function errorOf(res: { json(): Promise<unknown> }): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}
