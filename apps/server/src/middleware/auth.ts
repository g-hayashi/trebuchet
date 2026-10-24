import { hashToken } from "@trebuchet/db";
import {
  type AuthStore,
  type Clock,
  isSessionActive,
  requiresAuth,
  type Session,
  type SessionKind,
} from "@trebuchet/domain";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { DomainException } from "../errors.ts";
import { isLocalHost, rpIdFor } from "../lib/origin.ts";
import { SESSION_COOKIE } from "../lib/session.ts";
import type { GuardEnv } from "./host.ts";

/** last_seen_at の更新は1分に1回まで（R5） */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** 初回の登録の手続き（パスキーが0件、かつローカルの Host が前提） */
const REGISTER_PATHS = new Set(["/api/auth/register/options", "/api/auth/register/verify"]);
/** 回復用の一時セッションでだけ呼べる手続き */
const RECOVERY_REGISTER_PATHS = new Set([
  "/api/auth/recovery/register/options",
  "/api/auth/recovery/register/verify",
]);

/**
 * cookie のセッションを探す。種類が違う・失効・期限切れ・RP ID が要求の Host と違うものは undefined。
 * 要サインインの検査と、公開の `GET /auth/status` の `signedIn` が同じ判定を使う
 */
export async function findActiveSession(
  c: Context<GuardEnv>,
  store: AuthStore,
  now: string,
  kind: SessionKind,
): Promise<Session | undefined> {
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await store.findSessionByTokenHash(hashToken(token)) : undefined;
  if (
    session === undefined ||
    session.kind !== kind ||
    !isSessionActive(session, now) ||
    session.rpId !== rpIdFor(c.var.host, c.var.remote)
  ) {
    return undefined;
  }
  return session;
}

const unauthenticated = () =>
  new DomainException({ code: "UNAUTHENTICATED", message: "サインインが必要です" });

/**
 * 検査 3: 認証（FR-003）。`requiresAuth` が true のパスは、有効な通常のセッションが必要。
 * 公開の手続きのうち前提のあるものは、前提を満たさなければ 401・409・421 で止める
 * （`pairing/register/*` のトークンは本文を読むので、そのルートが検査する）
 */
export const authCheck = (getStore: () => AuthStore, clock: Clock) =>
  createMiddleware<GuardEnv>(async (c, next) => {
    const { method } = c.req;
    const path = c.req.path;
    const isRegister = method === "POST" && REGISTER_PATHS.has(path);
    const isRecoveryRegister = method === "POST" && RECOVERY_REGISTER_PATHS.has(path);

    // ほかの公開の手続きは、DB を開かずに通す
    if (!requiresAuth(method, path) && !isRegister && !isRecoveryRegister) return next();

    const store = getStore();

    if (isRegister) {
      if ((await store.listPasskeys()).length > 0) {
        throw new DomainException({
          code: "ALREADY_REGISTERED",
          message: "すでにパスキーが登録されています",
        });
      }
      if (!isLocalHost(c.var.host)) {
        throw new DomainException({
          code: "HOST_NOT_ALLOWED",
          message: "最初の登録は、この Mac の localhost からだけできます",
        });
      }
      return next();
    }

    const now = clock.now();
    const session = await findActiveSession(
      c,
      store,
      now,
      isRecoveryRegister ? "recovery" : "normal",
    );
    if (session === undefined) throw unauthenticated();
    if (
      session.kind === "normal" &&
      Date.parse(now) - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS
    ) {
      await store.touchSession(session.id, now);
    }
    c.set("session", session);
    await next();
  });
