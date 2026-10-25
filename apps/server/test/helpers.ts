import { randomUUIDv7 } from "node:crypto";
import { DrizzleAuthStore, openRegistry } from "@trebuchet/db";
import type { Clock, SessionKind } from "@trebuchet/domain";
import { testClient } from "hono/testing";
import { app as realApp } from "../src/app.ts";
import { DEV_WEB_HOST, DEV_WEB_ORIGIN } from "../src/lib/origin.ts";
import { issueSession, SESSION_COOKIE } from "../src/lib/session.ts";

/** テストが使う接続先（Vite の proxy 経由と同じ。ローカルの Host・オリジン） */
export const TEST_HOST = DEV_WEB_HOST;
export const TEST_ORIGIN = DEV_WEB_ORIGIN;

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
  const { id, token } = await issueSession(new DrizzleAuthStore(openRegistry()), {
    id: randomUUIDv7(),
    now: opts.now ?? new Date().toISOString(),
    kind: opts.kind ?? "normal",
    rpId: opts.rpId ?? "localhost",
    passkeyId: opts.passkeyId ?? null,
    userAgent: null,
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

/** テスト用の事業体（個人事業）を作成し、その ID を返す */
export async function createTestEntity(name = "個人事業", firstFiscalYear = 2026): Promise<string> {
  const res = await client.api.entities.$post({
    json: { name, kind: "individual", fiscalStartMonth: 1, firstFiscalYear },
  });
  if (res.status !== 201) throw new Error(`entity create failed: ${res.status}`);
  const body = await res.json();
  return body.entity.id;
}

/** 事業体の勘定科目を名前で引く関数を返す（科目がなければ、その関数が例外を投げる） */
export async function accountLookup(entityId: string): Promise<(name: string) => string> {
  const res = await client.api.entities[":entityId"].accounts.$get({ param: { entityId } });
  if (res.status !== 200) throw new Error(`accounts failed: ${res.status}`);
  const ids = new Map((await res.json()).accounts.map((a) => [a.name, a.id]));
  return (name) => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`科目がない: ${name}`);
    return id;
  };
}

/** 借方・貸方 1 行ずつ（科目名と金額）の仕訳を登録して返す（201 でなければ例外） */
export async function postSimpleJournal(
  entityId: string,
  accountId: (name: string) => string,
  debit: string,
  credit: string,
  amount: number,
  date: string,
) {
  const res = await client.api.entities[":entityId"].journals.$post({
    param: { entityId },
    json: {
      date,
      lines: [
        { side: "debit", accountId: accountId(debit), amount },
        { side: "credit", accountId: accountId(credit), amount },
      ],
    },
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return (await res.json()).journal;
}

export async function errorOf(res: { json(): Promise<unknown> }): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

/** 状態を確かめたうえで成功のボディを返す（違えば本文つきで例外） */
export async function json<T>(res: Response, status: number): Promise<T> {
  if (res.status !== status) {
    throw new Error(`expected ${status} but got ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** エラーの応答（{ error }）を除いた成功のボディの型にする */
export const okBody = async <R extends { json(): Promise<unknown> }>(
  res: R,
): Promise<Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>> =>
  (await res.json()) as Exclude<Awaited<ReturnType<R["json"]>>, { error: unknown }>;

/** 進められる偽の時計（`advance` はミリ秒、`set` は ISO 文字列） */
export function makeClock(start = "2026-10-20T09:00:00.000Z") {
  let ms = Date.parse(start);
  const clock: Clock & { advance(d: number): void; set(iso: string): void } = {
    now: () => new Date(ms).toISOString(),
    advance: (d) => {
      ms += d;
    },
    set: (iso) => {
      ms = Date.parse(iso);
    },
  };
  return clock;
}
