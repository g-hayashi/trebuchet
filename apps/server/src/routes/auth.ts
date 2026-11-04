import { randomBytes } from "node:crypto";
import {
  DK_BYTES,
  generateRecoveryKey,
  parseRecoveryKey,
  unwrapDataKey,
  wrapDataKey,
} from "@trebuchet/db";
import {
  type AuthStore,
  type Clock,
  canDeletePasskey,
  domainError,
  encodeCsv,
  LOCAL_RP_ID,
  type NewPasskey,
  type Passkey,
  type Session,
} from "@trebuchet/domain";
import {
  type AuthStatus,
  PasskeyRenameInput,
  RecoveryVerifyInput,
  RegisterVerifyInput,
  type SessionView,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { DomainException } from "../errors.ts";
import {
  type AuthSupport,
  type Ctx,
  prfUnsupported,
  refOf,
  toPasskeyView,
  webauthnFailed,
} from "../lib/auth-support.ts";
import type { ChallengeStore } from "../lib/challenges.ts";
import { expectedOriginFor, isLocalHost, rpIdFor } from "../lib/origin.ts";
import { clearSessionCookie } from "../lib/session.ts";
import { sweepSessions } from "../lib/session-sweeper.ts";
import { setAsideDataFiles, type Vault } from "../lib/vault.ts";
import { readPrf, responseKind } from "../lib/webauthn-response.ts";
import { findActiveSession } from "../middleware/auth.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

export type AuthRouteDeps = {
  store: () => AuthStore;
  clock: Clock;
  challenges: ChallengeStore;
  /** 解錠中の DK（008 の D3） */
  vault: Vault;
  /** 登録・セッション・再認証の共通部品（ペアリングのルートと共有する） */
  support: AuthSupport;
  /** 回復キーの失敗のたびに待たせる（D5。既定は setTimeout。テストは待たない関数を渡す） */
  delay?: (ms: number) => Promise<void>;
};

/** 回復キーの失敗ごとの遅延（D5。全体のロックはしない） */
export const RECOVERY_FAILURE_DELAY_MS = 1000;

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const alreadyRegistered = () =>
  new DomainException(domainError("ALREADY_REGISTERED", "すでに設定されています"));
const unauthenticated = () =>
  new DomainException(domainError("UNAUTHENTICATED", "サインインが必要です"));

const refsOf = (passkeys: Passkey[], rpId: string) =>
  passkeys.filter((p) => p.rpId === rpId).map(refOf);

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
  const { clock, challenges, vault, support } = deps;
  const {
    webauthn,
    reauth,
    nowMs,
    secure,
    record,
    takeChallenge,
    safely,
    beginRegistration,
    finishRegistration,
    newPasskey,
    assertNewCredential,
    startSession,
    requireReauth,
  } = support;
  const delay = deps.delay ?? sleep;
  /** 初回の設定を同時に 2 つ進めない（データの置き場所を移すため） */
  let settingUp = false;

  /** 新しい回復キーで recovery の包みを作る（DK は解錠中のもの）。秘密の乱数は 0 で埋める */
  function newRecoveryWrap() {
    const recovery = generateRecoveryKey();
    try {
      const wrap = vault.withDataKey((dk) => wrapDataKey(dk, recovery.secret, "recovery", null));
      return { text: recovery.text, wrap };
    } finally {
      recovery.secret.fill(0);
    }
  }

  /** 新しい回復キーを出したら、「控えた」の確認を外す */
  async function resetAcknowledgement(store: AuthStore) {
    await store.setSetting("recovery_code_acknowledged", "0", clock.now());
  }

  /** 初回の設定の前提（未設定、ローカルの Host）。ミドルウェアでも検査済みだが二重に確かめる */
  async function assertFirstRegistration(store: AuthStore, c: Ctx) {
    if ((await store.getRecoveryWrap()) !== undefined) throw alreadyRegistered();
    if (!isLocalHost(c.var.host)) {
      throw new DomainException(
        domainError("HOST_NOT_ALLOWED", "最初の登録は、この Mac の localhost からだけできます"),
      );
    }
  }

  /**
   * 初回の設定（D4.1）: DK と回復キーを作り、包みを 2 行入れ、前の registry・事業体の DB を脇へ移して
   * 新しい DK で空から作り、解錠する。回復キーの平文を返す（応答で 1 回だけ）
   */
  async function completeSetup(store: AuthStore, passkey: NewPasskey, prfOutput: Buffer) {
    if (settingUp) throw alreadyRegistered();
    settingUp = true;
    const dk = randomBytes(DK_BYTES);
    const recovery = generateRecoveryKey();
    try {
      if ((await store.getRecoveryWrap()) !== undefined) throw alreadyRegistered();
      const passkeyWrap = wrapDataKey(dk, prfOutput, "passkey", passkey.id);
      const recoveryWrap = wrapDataKey(dk, recovery.secret, "recovery", null);
      await vault.lock();
      setAsideDataFiles(clock.now());
      await store.initializeVault(passkey, passkeyWrap, recoveryWrap);
      vault.unlock(dk);
      return recovery.text;
    } finally {
      dk.fill(0);
      recovery.secret.fill(0);
      prfOutput.fill(0);
      settingUp = false;
    }
  }

  return (
    new Hono<GuardEnv>()
      .get("/status", async (c) => {
        const store = deps.store();
        const session = await findActiveSession(c, store, clock.now(), "normal");
        const signedIn = session !== undefined && vault.isUnlocked();
        const body: AuthStatus = {
          registered: (await store.getRecoveryWrap()) !== undefined,
          signedIn,
          rpId: rpIdFor(c.var.host, c.var.remote) ?? LOCAL_RP_ID,
          remote: { enabled: c.var.remote.enabled, host: c.var.remote.host },
          recoveryAcknowledged: signedIn
            ? (await store.getSetting("recovery_code_acknowledged")) === "1"
            : null,
        };
        return c.json(body, 200);
      })

      // 初回の設定（未設定のときだけ。D4.1）
      .post("/register/options", async (c) => {
        const store = deps.store();
        await assertFirstRegistration(store, c);
        const { rpId } = rpContext(c);
        return c.json(await beginRegistration(store, "register", rpId), 200);
      })
      .post("/register/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        await assertFirstRegistration(store, c);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        const step = await finishRegistration("register", input.response, rpId, origin);
        if (step.kind === "prf_required") {
          return c.json({ status: "prf_required" as const, options: step.options }, 200);
        }
        const passkey = newPasskey(step.registered, rpId, input.name);
        const recoveryCode = await completeSetup(store, passkey, step.registered.prfOutput);
        await resetAcknowledgement(store);
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ recoveryCode }, 201);
      })

      // サインイン（解錠。D4.2）
      .post("/sign-in/options", async (c) => {
        const store = deps.store();
        const { rpId } = rpContext(c);
        const passkeys = (await store.listPasskeys()).filter((p) => p.rpId === rpId);
        const options = await webauthn.authenticationOptions({
          rpId,
          allowed: passkeys.map(refOf),
          prfSalts: Object.fromEntries(passkeys.map((p) => [p.id, b64(p.prfSalt)])),
        });
        challenges.issue("sign-in", options.challenge);
        return c.json(options, 200);
      })
      .post("/sign-in/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const { rpId, origin } = rpContext(c);
        const { response } = c.req.valid("json");
        const taken =
          responseKind(response) === "authentication" ? takeChallenge("sign-in", response) : null;
        const credentialId = typeof response.id === "string" ? response.id : undefined;
        const passkey =
          credentialId === undefined ? undefined : await store.getPasskey(credentialId);
        const verified =
          taken === null || passkey === undefined || passkey.rpId !== rpId
            ? null
            : await safely(() =>
                webauthn.verifyAuthentication({
                  response,
                  expectedChallenge: (challenge) => challenge === taken.challenge,
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
        // PRF の出力は署名の対象外。正しさは包みが開けたかで判定する（落とし穴 3）
        const prf = readPrf(response);
        if (prf.first === null) {
          await record(store, c, "sign_in_failed", {
            passkeyId: passkey.id,
            detail: { reason: "prf_missing" },
          });
          throw prfUnsupported();
        }
        const wrap = await store.getPasskeyWrap(passkey.id);
        const dk =
          wrap === undefined ? null : unwrapDataKey(wrap, prf.first, "passkey", passkey.id);
        prf.first.fill(0);
        if (dk === null) {
          await record(store, c, "sign_in_failed", {
            passkeyId: passkey.id,
            detail: { reason: "unwrap" },
          });
          throw webauthnFailed();
        }
        try {
          vault.unlock(dk);
        } finally {
          dk.fill(0);
        }
        await store.recordPasskeyUse(passkey.id, verified.newCounter, clock.now());
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "sign_in", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ ok: true as const }, 200);
      })

      // 回復キー（D4.3。失敗ごとに 1 秒待たせ、全体のロックはしない。D5）
      .post("/recovery/verify", validate("json", RecoveryVerifyInput), async (c) => {
        const store = deps.store();
        const { rpId } = rpContext(c);
        const { code } = c.req.valid("json");
        const secret = parseRecoveryKey(code);
        const wrap = await store.getRecoveryWrap();
        const dk =
          secret === null || wrap === undefined
            ? null
            : unwrapDataKey(wrap, secret, "recovery", null);
        secret?.fill(0);
        if (dk === null) {
          await delay(RECOVERY_FAILURE_DELAY_MS);
          await record(store, c, "recovery_failed");
          throw new DomainException(domainError("RECOVERY_INVALID", "回復キーが違います"));
        }
        try {
          vault.unlock(dk);
        } finally {
          dk.fill(0);
        }
        // 回復キーはパスキーを登録するまで替えない（一時セッションの間は登録をやり直せる）
        const session = await startSession(store, c, rpId, "recovery", null);
        await record(store, c, "recovery_used", { sessionId: session.id });
        return c.json({ ok: true as const }, 200);
      })
      .post("/recovery/register/options", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const { rpId } = rpContext(c);
        return c.json(await beginRegistration(store, `recovery-register:${session.id}`, rpId), 200);
      })
      .post("/recovery/register/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const recoverySession = sessionOf(c);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        // 検証に失敗したときは、回復キーも一時セッションも変えない
        const step = await finishRegistration(
          `recovery-register:${recoverySession.id}`,
          input.response,
          rpId,
          origin,
        );
        if (step.kind === "prf_required") {
          return c.json({ status: "prf_required" as const, options: step.options }, 200);
        }
        const { prfOutput } = step.registered;
        const passkey = newPasskey(step.registered, rpId, input.name);
        let recovery: { text: string; wrap: ReturnType<typeof newRecoveryWrap>["wrap"] };
        try {
          await assertNewCredential(store, passkey.id);
          const passkeyWrap = vault.withDataKey((dk) =>
            wrapDataKey(dk, prfOutput, "passkey", passkey.id),
          );
          recovery = newRecoveryWrap();
          // パスキーを先に入れる（後の差し替えが失敗しても、古い回復キーと新しいパスキーで入れる）
          await store.addPasskey(passkey, passkeyWrap);
          await store.replaceRecoveryWrap(recovery.wrap, clock.now());
        } finally {
          prfOutput.fill(0);
        }
        await resetAcknowledgement(store);
        await store.revokeSession(recoverySession.id, clock.now());
        const session = await startSession(store, c, rpId, "normal", passkey.id);
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        await record(store, c, "recovery_regenerated", { sessionId: session.id });
        return c.json({ recoveryCode: recovery.text }, 201);
      })

      // ここから要サインイン（全権のセッションと解錠）
      .post("/sign-out", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        await record(store, c, "sign_out", { passkeyId: session.passkeyId, sessionId: session.id });
        // 施錠: 全セッションを消し、DK を消す（D4.5）
        await vault.lock();
        clearSessionCookie(c, { secure: secure(c) });
        return c.body(null, 204);
      })
      .post("/reauth/options", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const { rpId } = rpContext(c);
        const options = await webauthn.authenticationOptions({
          rpId,
          allowed: refsOf(await store.listPasskeys(), rpId),
        });
        challenges.issue(`reauth:${session.id}`, options.challenge);
        return c.json(options, 200);
      })
      .post("/reauth/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        const { rpId, origin } = rpContext(c);
        const { response } = c.req.valid("json");
        const taken =
          responseKind(response) === "authentication"
            ? takeChallenge(`reauth:${session.id}`, response)
            : null;
        const credentialId = typeof response.id === "string" ? response.id : undefined;
        const passkey =
          credentialId === undefined ? undefined : await store.getPasskey(credentialId);
        const verified =
          taken === null || passkey === undefined || passkey.rpId !== rpId
            ? null
            : await safely(() =>
                webauthn.verifyAuthentication({
                  response,
                  expectedChallenge: (challenge) => challenge === taken.challenge,
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
        if (passkey === undefined || verified === null) throw webauthnFailed();
        await store.recordPasskeyUse(passkey.id, verified.newCounter, clock.now());
        reauth.mark(session.id, nowMs());
        return c.body(null, 204);
      })
      .get("/passkeys", async (c) => {
        const passkeys = await deps.store().listPasskeys();
        return c.json({ passkeys: passkeys.map(toPasskeyView) }, 200);
      })
      .post("/passkeys/options", async (c) => {
        const session = sessionOf(c);
        requireReauth(session);
        const { rpId } = rpContext(c);
        return c.json(
          await beginRegistration(deps.store(), `passkey-add:${session.id}`, rpId),
          200,
        );
      })
      .post("/passkeys/verify", validate("json", RegisterVerifyInput), async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        requireReauth(session);
        const { rpId, origin } = rpContext(c);
        const input = c.req.valid("json");
        const step = await finishRegistration(
          `passkey-add:${session.id}`,
          input.response,
          rpId,
          origin,
        );
        if (step.kind === "prf_required") {
          return c.json({ status: "prf_required" as const, options: step.options }, 200);
        }
        const { prfOutput } = step.registered;
        const passkey = newPasskey(step.registered, rpId, input.name);
        try {
          await assertNewCredential(store, passkey.id);
          const wrap = vault.withDataKey((dk) => wrapDataKey(dk, prfOutput, "passkey", passkey.id));
          await store.addPasskey(passkey, wrap);
        } finally {
          prfOutput.fill(0);
        }
        await record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
        return c.json({ passkey: toPasskeyView({ ...passkey, lastUsedAt: null }) }, 201);
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
        requireReauth(session);
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
        // そのパスキーで作ったセッションを失効してから、パスキーとその包みを 1 トランザクションで消す
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
        await sweepSessions({ store, vault, now: clock.now() });
        return c.body(null, 204);
      })

      .post("/recovery/regenerate", async (c) => {
        const store = deps.store();
        const session = sessionOf(c);
        requireReauth(session);
        const recovery = newRecoveryWrap();
        await store.replaceRecoveryWrap(recovery.wrap, clock.now());
        await resetAcknowledgement(store);
        await record(store, c, "recovery_regenerated", { sessionId: session.id });
        return c.json({ recoveryCode: recovery.text }, 201);
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
        // 最後のセッションを失効したら施錠する（D3）
        await sweepSessions({ store, vault, now: clock.now() });
        return c.body(null, 204);
      })
      .get("/events", async (c) => {
        if (c.req.query("format") === "csv") {
          const events = await deps.store().listEvents();
          // 自由入力の detail・userAgent や資格情報・セッションの ID は CSV に含めない。
          return c.text(
            encodeCsv([
              ["日時", "種類", "端末の種類"],
              ...events.map((e) => [
                e.occurredAt,
                e.kind,
                e.rpId === null ? "不明" : e.rpId === LOCAL_RP_ID ? "この Mac" : "スマホ・リモート",
              ]),
            ]),
            200,
            {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": 'attachment; filename="auth-events.csv"',
              "Cache-Control": "no-store",
            },
          );
        }
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
