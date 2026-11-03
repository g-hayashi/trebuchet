import { randomBytes } from "node:crypto";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import {
  type AuthEventKind,
  type AuthStore,
  type Clock,
  domainError,
  type NewPasskey,
  type Passkey,
  type Session,
} from "@trebuchet/domain";
import type { PasskeyView } from "@trebuchet/schema";
import type { Context } from "hono";
import { ids } from "../deps.ts";
import { DomainException } from "../errors.ts";
import type { GuardEnv } from "../middleware/host.ts";
import type { ChallengeStore } from "./challenges.ts";
import { rpIdFor } from "./origin.ts";
import { ReauthTracker } from "./reauth.ts";
import { isSecureHost, issueSession, setSessionCookie } from "./session.ts";
import { sweepSessions } from "./session-sweeper.ts";
import type { Vault } from "./vault.ts";
import type { VerifiedRegistration, WebAuthnVerifier } from "./webauthn.ts";
import { challengeOf, readPrf, responseKind } from "./webauthn-response.ts";

/**
 * 認証のルート（`routes/auth.ts`）とペアリングのルート（`routes/pairing.ts`）が共有する部品。
 * 登録の 2 段（`prf_required`）、セッションの発行、再認証の記録、認証の記録を 1 か所に置く
 * （008 の D4。再認証の記録（ReauthTracker）は 1 つのアプリで 1 つ）
 */

export type AuthSupportDeps = {
  clock: Clock;
  webauthn: WebAuthnVerifier;
  challenges: ChallengeStore;
  /** 解錠中の DK（008 の D3） */
  vault: Vault;
};

export type Ctx = Context<GuardEnv>;

const PRF_SALT_BYTES = 32;
const DEFAULT_PASSKEY_NAME = "パスキー";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const webauthnFailed = () =>
  new DomainException(
    domainError("WEBAUTHN_FAILED", "パスキーの確認に失敗しました。もう一度お試しください"),
  );
export const prfUnsupported = () =>
  new DomainException(
    domainError(
      "PRF_UNSUPPORTED",
      "このパスキーは鍵の保護（PRF）に対応していません。iCloud キーチェーンや 1Password などのパスキーを使ってください",
    ),
  );
const reauthRequired = () =>
  new DomainException(
    domainError("REAUTH_REQUIRED", "この操作の前に、パスキーでもう一度確認してください"),
  );

export const toPasskeyView = (p: Passkey): PasskeyView => ({
  id: p.id,
  name: p.name,
  rpId: p.rpId,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

export const refOf = (p: { id: string; transports: string[] | null }) => ({
  id: p.id,
  ...(p.transports ? { transports: p.transports } : {}),
});

/** 登録の options を出したときに覚える値 */
type PendingRegistration = { prfSalt: Buffer };
/** 登録で PRF の出力が返らなかったとき、続けて行う認証のために覚える値（D4.1 の `prf_required`） */
type PendingPrf = { prfSalt: Buffer; credential: VerifiedRegistration };
/** 登録を検証し、PRF の出力まで得たもの。`prfOutput` は包みを作ったら 0 で埋める */
export type Registered = {
  credential: VerifiedRegistration;
  prfSalt: Buffer;
  prfOutput: Buffer;
};
export type RegistrationStep =
  | { kind: "done"; registered: Registered }
  | { kind: "prf_required"; options: PublicKeyCredentialRequestOptionsJSON };

export function createAuthSupport(deps: AuthSupportDeps) {
  const { clock, webauthn, challenges, vault } = deps;
  const reauth = new ReauthTracker();

  const secure = (c: Ctx) => isSecureHost(c.var.host, c.var.remote);
  const nowMs = () => Date.parse(clock.now());

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
   * 応答の challenge（clientDataJSON）を、用途（scope）が合うものとして 1 回だけ取り出す。
   * 知らない・使い済み・期限切れ・用途違いは null
   */
  function takeChallenge(scope: string, response: unknown) {
    const challenge = challengeOf(response);
    if (challenge === null) return null;
    const entry = challenges.take(scope, challenge);
    return entry === undefined ? null : { challenge, data: entry.data };
  }

  /** 検証の失敗（null）と例外を同じに扱う（呼び出し側が 400 にする） */
  async function safely<T>(run: () => Promise<T | null>): Promise<T | null> {
    try {
      return await run();
    } catch {
      return null;
    }
  }

  /** 登録の options。除外する認証器は、この RP ID の既存のパスキー。PRF の salt を新しく作る */
  async function beginRegistration(store: AuthStore, scope: string, rpId: string) {
    const prfSalt = randomBytes(PRF_SALT_BYTES);
    const options = await webauthn.registrationOptions({
      rpId,
      excluded: (await store.listPasskeys()).filter((p) => p.rpId === rpId).map(refOf),
      prfSalt: b64(prfSalt),
    });
    challenges.issue(scope, options.challenge, { prfSalt } satisfies PendingRegistration);
    return options;
  }

  /**
   * 登録の応答を検証する（D4.1）。PRF が使えなければ 400 PRF_UNSUPPORTED。
   * 登録で PRF の出力が返らない認証器には、続けて認証を 1 回求める（`prf_required`。同じ verify に送る）
   */
  async function finishRegistration(
    scope: string,
    response: Record<string, unknown>,
    rpId: string,
    origin: string,
  ): Promise<RegistrationStep> {
    const kind = responseKind(response);
    if (kind === "registration") {
      const taken = takeChallenge(scope, response);
      if (taken === null) throw webauthnFailed();
      const { prfSalt } = taken.data as PendingRegistration;
      const credential = await safely(() =>
        webauthn.verifyRegistration({
          response,
          expectedChallenge: (challenge) => challenge === taken.challenge,
          expectedOrigin: origin,
          expectedRpId: rpId,
        }),
      );
      if (credential === null) throw webauthnFailed();
      const prf = readPrf(response);
      if (!prf.enabled) throw prfUnsupported();
      if (prf.first !== null) {
        return { kind: "done", registered: { credential, prfSalt, prfOutput: prf.first } };
      }
      const options = await webauthn.authenticationOptions({
        rpId,
        allowed: [refOf(credential)],
        prfSalts: { [credential.id]: b64(prfSalt) },
      });
      challenges.issue(`${scope}:prf`, options.challenge, {
        prfSalt,
        credential,
      } satisfies PendingPrf);
      return { kind: "prf_required", options };
    }
    if (kind === "authentication") {
      const taken = takeChallenge(`${scope}:prf`, response);
      if (taken === null) throw webauthnFailed();
      const pending = taken.data as PendingPrf;
      if (response.id !== pending.credential.id) throw webauthnFailed();
      const verified = await safely(() =>
        webauthn.verifyAuthentication({
          response,
          expectedChallenge: (challenge) => challenge === taken.challenge,
          expectedOrigin: origin,
          expectedRpId: rpId,
          credential: {
            id: pending.credential.id,
            publicKey: pending.credential.publicKey,
            counter: pending.credential.counter,
            ...(pending.credential.transports ? { transports: pending.credential.transports } : {}),
          },
        }),
      );
      if (verified === null) throw webauthnFailed();
      const prf = readPrf(response);
      if (prf.first === null) throw prfUnsupported();
      return {
        kind: "done",
        registered: {
          credential: { ...pending.credential, counter: verified.newCounter },
          prfSalt: pending.prfSalt,
          prfOutput: prf.first,
        },
      };
    }
    throw webauthnFailed();
  }

  function newPasskey(registered: Registered, rpId: string, name: string | undefined): NewPasskey {
    const { credential, prfSalt } = registered;
    return {
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      rpId,
      transports: credential.transports,
      name: name ?? DEFAULT_PASSKEY_NAME,
      prfSalt,
      createdAt: clock.now(),
    };
  }

  /** すでにある資格情報の ID の登録は 400（同じ認証器の二重登録・行の差し替えを防ぐ） */
  async function assertNewCredential(store: AuthStore, id: string) {
    if ((await store.getPasskey(id)) !== undefined) throw webauthnFailed();
  }

  /**
   * セッションを作って cookie に入れる。新しいセッションを入れてから期限切れを掃除する
   * （逆にすると解錠の直後に施錠される。D3、落とし穴 5）
   */
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
    // パスキーで本人を確かめた直後のセッションは、再認証の済んだものとして扱う
    if (kind === "normal") reauth.mark(session.id, nowMs());
    await sweepSessions({ store, vault, now: clock.now() });
    return session;
  }

  /** 全権のセッションで、直近 5 分以内のパスキーの再認証を求める（D4.4） */
  function requireReauth(session: Session) {
    if (!reauth.isFresh(session.id, nowMs())) throw reauthRequired();
  }

  return {
    webauthn,
    reauth,
    secure,
    nowMs,
    record,
    takeChallenge,
    safely,
    beginRegistration,
    finishRegistration,
    newPasskey,
    assertNewCredential,
    startSession,
    requireReauth,
  };
}

export type AuthSupport = ReturnType<typeof createAuthSupport>;
