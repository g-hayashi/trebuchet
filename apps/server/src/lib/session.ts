import { randomBytes } from "node:crypto";
import { hashToken } from "@trebuchet/db";
import type { AuthStore, SessionKind } from "@trebuchet/domain";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { expectedOriginFor, type RemoteSettings } from "./origin.ts";

/** セッションの cookie の名前（R5） */
export const SESSION_COOKIE = "trebuchet_session";

/** 32 バイトの乱数を base64url にしたトークン（43 文字） */
function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export type IssueSessionInput = {
  /** 呼び出し側が決める ID（`ids.next()`）と時刻（`clock.now()`） */
  id: string;
  now: string;
  kind: SessionKind;
  rpId: string;
  /** 回復用の一時セッションは null */
  passkeyId: string | null;
  userAgent: string | null;
};

/**
 * セッションを作る。DB に残すのはトークンのハッシュだけ。トークンの平文は戻り値でだけ渡す。
 * 回復用の一時セッション（`kind: "recovery"`、10 分、パスキーの登録の手続きだけに使える）も同じ関数で作る
 */
export async function issueSession(
  store: AuthStore,
  input: IssueSessionInput,
): Promise<{ id: string; token: string }> {
  const token = newSessionToken();
  await store.createSession({
    id: input.id,
    tokenHash: hashToken(token),
    kind: input.kind,
    rpId: input.rpId,
    passkeyId: input.passkeyId,
    userAgent: input.userAgent,
    now: input.now,
  });
  return { id: input.id, token };
}

/** cookie に Secure を付けるか（https の接続先のとき） */
export function isSecureHost(host: string | undefined, remote?: RemoteSettings): boolean {
  return expectedOriginFor(host, remote)?.startsWith("https://") ?? false;
}

/** HttpOnly・SameSite=Strict・Path=/、https のとき Secure */
export function setSessionCookie(c: Context, token: string, opts: { secure: boolean }): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: opts.secure,
  });
}

export function clearSessionCookie(c: Context, opts: { secure: boolean }): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: opts.secure });
}
