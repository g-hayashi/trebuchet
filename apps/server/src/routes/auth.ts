import {
  type AuthEventKind,
  type AuthStore,
  type Clock,
  canDeletePasskey,
  domainError,
  LOCAL_RP_ID,
  type Passkey,
  RECOVERY_LOCK_MS,
  recoveryLocked,
  type Session,
} from "@trebuchet/domain";
import {
  type AuthStatus,
  PasskeyRenameInput,
  type PasskeyView,
  RecoveryVerifyInput,
  RegisterVerifyInput,
  type SessionView,
} from "@trebuchet/schema";
import { type Context, Hono } from "hono";
import { ids } from "../deps.ts";
import { DomainException } from "../errors.ts";
import type { ChallengeStore } from "../lib/challenges.ts";
import { expectedOriginFor, isLocalHost, rpIdFor } from "../lib/origin.ts";
import { generateRecoveryCode, hashRecoveryCode } from "../lib/recovery-code.ts";
import {
  clearSessionCookie,
  isSecureHost,
  issueSession,
  setSessionCookie,
} from "../lib/session.ts";
import type { VerifiedRegistration, WebAuthnVerifier } from "../lib/webauthn.ts";
import { findActiveSession } from "../middleware/auth.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

export type AuthRouteDeps = {
  store: () => AuthStore;
  clock: Clock;
  webauthn: WebAuthnVerifier;
  challenges: ChallengeStore;
};

type Ctx = Context<GuardEnv>;

const DEFAULT_PASSKEY_NAME = "パスキー";
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
/** recoveryLocked に渡す記録の範囲。連続の判定は期間に限らないので全期間を読む（件数は少ない） */
const EPOCH = "0000-01-01T00:00:00.000Z";

const webauthnFailed = () =>
  new DomainException(
    domainError("WEBAUTHN_FAILED", "パスキーの確認に失敗しました。もう一度お試しください"),
  );

const unauthenticated = () =>
  new DomainException(domainError("UNAUTHENTICATED", "サインインが必要です"));

const toPasskeyView = (p: Passkey): PasskeyView => ({
  id: p.id,
  name: p.name,
  rpId: p.rpId,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

const refsOf = (passkeys: Passkey[], rpId: string) =>
  passkeys
    .filter((p) => p.rpId === rpId)
    .map((p) => ({ id: p.id, ...(p.transports ? { transports: p.transports } : {}) }));

/** 要求の接続先の RP ID と期待する origin（`lib/origin.ts` で決める）。決まらなければ 421 */
function rpContext(c: Ctx): { rpId: string; origin: string } {
  const rpId = rpIdFor(c.var.host, c.var.remote);
  const origin = expectedOriginFor(c.var.host, c.var.remote);
  if (rpId === undefined || origin === undefined) {
    throw new DomainException(
      domainError("HOST_NOT_ALLOWED", "この接続先ではパスキーを使えません"),
    );
  }
  return { rpId, origin };
}

/** 回復用の一時セッション・通常のセッションは、検査（middleware/auth.ts）が `c.var.session` に入れる */
function sessionOf(c: Ctx): Session {
  const session = c.var.session;
  if (session === undefined) throw unauthenticated();
  return session;
}

export function authRoutes(deps: AuthRouteDeps) {
  const { clock, webauthn, challenges } = deps;

  const secure = (c: Ctx) => isSecureHost(c.var.host, c.var.remote);

  async function record(
    store: AuthStore,
    c: Ctx,
    kind: AuthEventKind,
    extra: {
      passkeyId?: string | null;
      sessionId?: string | null;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    await store.appendEvent({
      id: ids.next(),
      occurredAt: clock.now(),
      kind,
      rpId: rpIdFor(c.var.host, c.var.remote) ?? null,
      passkeyId: extra.passkeyId ?? null,
      sessionId: extra.sessionId ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      detail: extra.detail ?? null,
    });
  }

  /**
   * 応答を検証する。challenge は用途（scope）が合うものを 1 回だけ使う。
   * 失敗・challenge の不一致・期限切れ・捨てられたものは null（呼び出し側が 400 にする）
   */
  async function verifyWith<T>(
    scope: string,
    run: (expectedChallenge: (challenge: string) => boolean) => Promise<T | null>,
  ): Promise<T | null> {
    let matched = false;
    const expectedChallenge = (challenge: string) => {
      const ok = challenges.consume(scope, challenge);
      if (ok) matched = true;
      return ok;
    };
    try {
      const result = await run(expectedChallenge);
      return result !== null && matched ? result : null;
    } catch {
      return null;
    }
  }

  /** 新しい回復コードを発行する。古い有効なコードは closeAs で閉じ、「控えた」の確認を外す */
  async function issueRecoveryCode(store: AuthStore, closeAs: "used" | "revoked") {
    const recoveryCode = generateRecoveryCode();
    const now = clock.now();
    await store.replaceRecoveryCode(hashRecoveryCode(recoveryCode), now, closeAs);
    await store.setSetting("recovery_code_acknowledged", "0", now);
    return recoveryCode;
  }

  async function addVerifiedPasskey(
    store: AuthStore,
    v: VerifiedRegistration,
    rpId: string,
    name: string | undefined,
  ): Promise<Passkey> {
    if ((await store.getPasskey(v.id)) !== undefined) throw webauthnFailed();
    const passkey = {
      id: v.id,
      publicKey: v.publicKey,
      counter: v.counter,
      rpId,
      transports: v.transports,
      name: name ?? DEFAULT_PASSKEY_NAME,
      createdAt: clock.now(),
    };
    await store.addPasskey(passkey);
    return { ...passkey, lastUsedAt: null };
  }

  /** 登録の options。除外する認証器は、この RP ID の既存のパスキー */
  async function registrationOptions(store: AuthStore, scope: string, rpId: string) {
    const options = await webauthn.registrationOptions({
      rpId,
      excluded: refsOf(await store.listPasskeys(), rpId),
    });
    challenges.issue(scope, options.challenge);
    return options;
  }

  async function startSession(
    store: AuthStore,
    c: Ctx,
    rpId: string,
    kind: "normal" | "recovery",
    passkeyId: string | null,
  ) {
    const session = await issueSession(store, {
      id: ids.next(),
      now: clock.now(),
      kind,
      rpId,
      passkeyId,
      userAgent: c.req.header("user-agent") ?? null,
    });
    setSessionCookie(c, session.token, { secure: secure(c) });
    return session;
  }

  /** 初回の登録の前提（パスキー 0 件、ローカルの Host）。ミドルウェアでも検査済みだが二重に確かめる */
  async function assertFirstRegistration(store: AuthStore, c: Ctx) {
    if ((await store.listPasskeys()).length > 0) {
      throw new DomainException(
        domainError("ALREADY_REGISTERED", "すでにパスキーが登録されています"),
      );
    }
    if (!isLocalHost(c.var.host)) {
      throw new DomainException(
        domainError("HOST_NOT_ALLOWED", "最初の登録は、この Mac の localhost からだけできます"),
      );
    }
  }

  return (
    new Hono<GuardEnv>()
      .get("/status", async (c) => {
        const store = deps.store();
        const session = await findActiveSession(c, store, clock.now(), "normal");
        const signedIn = session !== undefined;
        const body: AuthStatus = {
          registered: (await store.listPasskeys()).length > 0,
          signedIn,
          rpId: rpIdFor(c.var.host, c.var.remote) ?? LOCAL_RP_ID,
          remote: { enabled: c.var.remote.enabled, host: c.var.remote.host },
          recoveryAcknowledged: signedIn
            ? (await store.getSetting("recovery_code_acknowledged")) === "1"
            : null,
        };
        return c.json(body, 200);
      })

      // 初回の登録（パスキー 0 件のときだけ）
      .post("/register/options", async (c) => {
        const store = deps.store();
        await assertFirstRegistration(store, c);
        const { rpId } = rpContext(c);
        return c.json(await registrationOptions(store, "register", rpId), 200);
      })
      .post("/register/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        await assertFirstRegistration(store, c);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        const verified = await verifyWith("register", (expectedChallenge) =>
          webauthn.verifyRegistration({
            response: input.response,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRpId: rpId,
          }),
        );
        if (verified === null) throw webauthnFailed();
        await assertFirstRegistration(store, c);
        const passkey = await addVerifiedPasskey(store, verified, rpId, input.name);
        const recoveryCode = await issueRecoveryCode(store, "revoked");
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ recoveryCode }, 201);
      })

      // サインイン
      .post("/sign-in/options", async (c) => {
        const store = deps.store();
        const { rpId } = rpContext(c);
        const options = await webauthn.authenticationOptions({
          rpId,
          allowed: refsOf(await store.listPasskeys(), rpId),
        });
        challenges.issue("sign-in", options.challenge);
        return c.json(options, 200);
      })
      .post("/sign-in/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const { rpId, origin } = rpContext(c);
        const { response } = c.req.valid("json");
        const credentialId = typeof response.id === "string" ? response.id : undefined;
        const passkey =
          credentialId === undefined ? undefined : await store.getPasskey(credentialId);
        const verified =
          passkey === undefined || passkey.rpId !== rpId
            ? null
            : await verifyWith("sign-in", (expectedChallenge) =>
                webauthn.verifyAuthentication({
                  response,
                  expectedChallenge,
                  expectedOrigin: origin,
                  expectedRpId: rpId,
                  credential: {
                    id: passkey.id,
                    publicKey: passkey.publicKey,
                    counter: passkey.counter,
                    ...(passkey.transports ? { transports: passkey.transports } : {}),
                  },
                }),
              );
        if (passkey === undefined || verified === null) {
          await record(store, c, "sign_in_failed", { passkeyId: passkey?.id ?? null });
          throw webauthnFailed();
        }
        await store.recordPasskeyUse(passkey.id, verified.newCounter, clock.now());
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "sign_in", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ ok: true as const }, 200);
      })

      // 回復コード
      .post("/recovery/verify", validate("json", RecoveryVerifyInput), async (c) => {
        const store = deps.store();
        const { rpId } = rpContext(c);
        const { code } = c.req.valid("json");
        const now = clock.now();
        const history = await store.listEventsSince(EPOCH, ["recovery_failed", "recovery_used"]);
        if (recoveryLocked(history, now)) {
          const last = history.find((e) => e.kind === "recovery_failed");
          const lastMs = last === undefined ? Date.parse(now) : Date.parse(last.occurredAt);
          const retryAfter = Math.max(
            1,
            Math.ceil((lastMs + RECOVERY_LOCK_MS - Date.parse(now)) / 1000),
          );
          throw new DomainException(
            domainError("RECOVERY_LOCKED", "回復コードの失敗が続いたため、しばらく試せません", {
              retryAfter,
            }),
          );
        }
        const active = await store.getActiveRecoveryCode();
        if (active === undefined || active.codeHash !== hashRecoveryCode(code)) {
          await record(store, c, "recovery_failed");
          throw new DomainException(domainError("RECOVERY_INVALID", "回復コードが違います"));
        }
        // 回復コードは消費しない（R7）。一時セッションの間は登録をやり直せる
        const session = await startSession(store, c, rpId, "recovery", null);
        await record(store, c, "recovery_used", { sessionId: session.id });
        return c.json({ ok: true as const }, 200);
      })
      .post("/recovery/register/options", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const { rpId } = rpContext(c);
        return c.json(
          await registrationOptions(store, `recovery-register:${session.id}`, rpId),
          200,
        );
      })
      .post("/recovery/register/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const recoverySession = sessionOf(c);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        // 検証に失敗したときは、回復コードも一時セッションも変えない
        const verified = await verifyWith(
          `recovery-register:${recoverySession.id}`,
          (expectedChallenge) =>
            webauthn.verifyRegistration({
              response: input.response,
              expectedChallenge,
              expectedOrigin: origin,
              expectedRpId: rpId,
            }),
        );
        if (verified === null) throw webauthnFailed();
        const passkey = await addVerifiedPasskey(store, verified, rpId, input.name);
        const recoveryCode = await issueRecoveryCode(store, "used");
        await store.revokeSession(recoverySession.id, clock.now());
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        await record(store, c, "recovery_regenerated", { sessionId: session.id });
        return c.json({ recoveryCode }, 201);
      })

      // ここから要サインイン
      .post("/sign-out", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        await store.revokeSession(session.id, clock.now());
        await record(store, c, "sign_out", { passkeyId: session.passkeyId, sessionId: session.id });
        clearSessionCookie(c, { secure: secure(c) });
        return c.body(null, 204);
      })
      .get("/passkeys", async (c) => {
        const passkeys = await deps.store().listPasskeys();
        return c.json({ passkeys: passkeys.map(toPasskeyView) }, 200);
      })
      .post("/passkeys/options", async (c) => {
        const session = sessionOf(c);
        const { rpId } = rpContext(c);
        return c.json(
          await registrationOptions(deps.store(), `passkey-add:${session.id}`, rpId),
          200,
        );
      })
      .post("/passkeys/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        const verified = await verifyWith(`passkey-add:${session.id}`, (expectedChallenge) =>
          webauthn.verifyRegistration({
            response: input.response,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRpId: rpId,
          }),
        );
        if (verified === null) throw webauthnFailed();
        const passkey = await addVerifiedPasskey(store, verified, rpId, input.name);
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ passkey: toPasskeyView(passkey) }, 201);
      })
      .patch("/passkeys/:id", validate("json", PasskeyRenameInput), async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const id = c.req.param("id");
        const { name } = c.req.valid("json");
        if ((await store.getPasskey(id)) === undefined) {
          throw new DomainException(
            domainError("VALIDATION", "パスキーが見つかりません", {
              issues: [{ path: ["id"], message: "パスキーが見つかりません" }],
            }),
          );
        }
        await store.renamePasskey(id, name);
        await record(store, c, "passkey_renamed", { passkeyId: id, sessionId: session.id });
        const updated = await store.getPasskey(id);
        return c.json({ passkey: toPasskeyView(updated as Passkey) }, 200);
      })
      .delete("/passkeys/:id", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const id = c.req.param("id");
        const passkeys = await store.listPasskeys();
        // 存在しない ID は何も変えない（冪等）
        if (!passkeys.some((p) => p.id === id)) return c.body(null, 204);
        if (!canDeletePasskey(passkeys, id)) {
          throw new DomainException(
            domainError("LAST_PASSKEY", "この Mac（localhost）の最後のパスキーは削除できません"),
          );
        }
        const now = clock.now();
        // そのパスキーで作ったセッションを失効してから削除する
        const revoked = await store.revokeSessionsByPasskey(id, now);
        await store.deletePasskey(id);
        await record(store, c, "passkey_deleted", { passkeyId: id, sessionId: session.id });
        for (const sessionId of revoked) {
          await record(store, c, "session_revoked", {
            passkeyId: id,
            sessionId,
            detail: { reason: "passkey_deleted" },
          });
        }
        if (revoked.includes(session.id)) clearSessionCookie(c, { secure: secure(c) });
        return c.body(null, 204);
      })

      .post("/recovery/regenerate", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const recoveryCode = await issueRecoveryCode(store, "revoked");
        await record(store, c, "recovery_regenerated", { sessionId: session.id });
        return c.json({ recoveryCode }, 201);
      })
      .post("/recovery/acknowledge", async (c) => {
        await deps.store().setSetting("recovery_code_acknowledged", "1", clock.now());
        return c.body(null, 204);
      })

      .get("/sessions", async (c) => {
        const current = sessionOf(c);
        const sessions = await deps.store().listActiveSessions(clock.now());
        const views: SessionView[] = sessions
          .filter((s) => s.kind === "normal")
          .map((s) => ({
            id: s.id,
            rpId: s.rpId,
            userAgent: s.userAgent,
            createdAt: s.createdAt,
            lastSeenAt: s.lastSeenAt,
            current: s.id === current.id,
          }));
        return c.json({ sessions: views }, 200);
      })
      .delete("/sessions/:id", async (c) => {
        const store = deps.store();
        const current = sessionOf(c);
        const id = c.req.param("id");
        const target = (await store.listActiveSessions(clock.now())).find(
          (s) => s.id === id && s.kind === "normal",
        );
        // 存在しない・失効済みは何も変えない（冪等）
        if (target === undefined) return c.body(null, 204);
        await store.revokeSession(id, clock.now());
        await record(store, c, "session_revoked", {
          passkeyId: target.passkeyId,
          sessionId: id,
          detail: { by: id === current.id ? "self" : "other_session" },
        });
        if (id === current.id) clearSessionCookie(c, { secure: secure(c) });
        return c.body(null, 204);
      })
      .get("/events", async (c) => {
        const raw = c.req.query("limit");
        let limit = DEFAULT_EVENT_LIMIT;
        if (raw !== undefined) {
          limit = Number(raw);
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
            throw new DomainException(
              domainError("VALIDATION", "入力が正しくありません", {
                issues: [
                  { path: ["limit"], message: `1〜${MAX_EVENT_LIMIT} の整数で指定してください` },
                ],
              }),
            );
          }
        }
        return c.json({ events: await deps.store().listEvents(limit) }, 200);
      })
  );
}
