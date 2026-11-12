import { randomBytes } from "node:crypto";
import { hashToken, wrapDataKey } from "@trebuchet/db";
import { type AuthStore, type Clock, domainError, LOCAL_RP_ID } from "@trebuchet/domain";
import { PairingRegisterOptionsInput, PairingRegisterVerifyInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { DomainException, lockedError } from "../errors.ts";
import { type AuthSupport, type Ctx, sessionOf, toPasskeyView } from "../lib/auth-support.ts";
import { ids } from "../lib/ids.ts";
import { expectedOriginFor, isLocalHost, rpIdFor } from "../lib/origin.ts";
import type { Vault } from "../lib/vault.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

/** ペアリングのトークンの有効な時間（FR-012） */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_BYTES = 32;

export type PairingRouteDeps = {
  store: () => AuthStore;
  clock: Clock;
  vault: Vault;
  /** 登録・セッション・再認証の共通部品（`routes/auth.ts` と共有） */
  support: AuthSupport;
};

const tokenInvalid = () =>
  new DomainException(
    domainError(
      "PAIRING_TOKEN_INVALID",
      "ペアリングの URL が無効か期限切れです。Mac でもう一度発行してください",
    ),
  );

/**
 * `/api/auth/pairing`（FR-012、research R17 の「008 以降」）。
 * - `POST /`: Mac（ローカルの Host）が発行する。全権のセッション＋直近 5 分の再認証。
 *   トークンは保存せず、ハッシュと期限だけを auth.sqlite に置く
 * - `POST /register/options`・`/register/verify`（公開）: ts.net の名前のパスキーを、トークンでだけ登録する。
 *   解錠中だけ有効。トークンの消費は、PRF の包みを作り終えてから、パスキーの追加と同じトランザクションで行う
 * トークン・URL をログ・`auth_events.detail` に出さない
 */
export function pairingRoutes(deps: PairingRouteDeps) {
  const { clock, vault, support } = deps;

  /** 公開の手続きの前提: 解錠中、ts.net の名前の Host（rpId と origin） */
  function remoteContext(c: Ctx): { rpId: string; origin: string } {
    if (!vault.isUnlocked()) throw new DomainException(lockedError());
    const rpId = rpIdFor(c.var.host, c.var.remote);
    const origin = expectedOriginFor(c.var.host, c.var.remote);
    if (rpId === undefined || rpId === LOCAL_RP_ID || origin === undefined) {
      throw new DomainException(
        domainError(
          "HOST_NOT_ALLOWED",
          "ペアリングの登録は、登録した ts.net の名前からだけできます",
        ),
      );
    }
    return { rpId, origin };
  }

  return new Hono<GuardEnv>()
    .post("/pairing", async (c) => {
      const store = deps.store();
      const session = sessionOf(c);
      if (!isLocalHost(c.var.host)) {
        throw new DomainException(
          domainError(
            "HOST_NOT_ALLOWED",
            "ペアリングの発行は、この Mac の localhost からだけできます",
          ),
        );
      }
      support.requireReauth(session);
      const remote = c.var.remote;
      const rpId = rpIdFor(remote.host ?? undefined, remote);
      if (!remote.enabled || rpId === undefined) {
        throw new DomainException(
          domainError(
            "REMOTE_NOT_CONFIGURED",
            "リモートが有効で、ts.net の名前が登録されているときだけ発行できます",
          ),
        );
      }
      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const now = clock.now();
      const expiresAt = new Date(Date.parse(now) + PAIRING_TOKEN_TTL_MS).toISOString();
      await store.deleteExpiredPairingTokens(now);
      await store.createPairingToken({
        id: ids.next(),
        tokenHash: hashToken(token),
        rpId,
        now,
        expiresAt,
      });
      await support.record(store, c, "pairing_issued", { sessionId: session.id });
      return c.json({ token, url: `https://${rpId}/pair?token=${token}`, expiresAt }, 201);
    })

    .post("/pairing/register/options", validate("json", PairingRegisterOptionsInput), async (c) => {
      const store = deps.store();
      const { rpId } = remoteContext(c);
      const tokenHash = hashToken(c.req.valid("json").token);
      if (!(await store.isPairingTokenValid(tokenHash, rpId, clock.now()))) throw tokenInvalid();
      return c.json(
        await support.beginRegistration(store, `pairing-register:${tokenHash}`, rpId),
        200,
      );
    })

    .post("/pairing/register/verify", validate("json", PairingRegisterVerifyInput), async (c) => {
      const store = deps.store();
      const { rpId, origin } = remoteContext(c);
      const input = c.req.valid("json");
      const tokenHash = hashToken(input.token);
      if (!(await store.isPairingTokenValid(tokenHash, rpId, clock.now()))) throw tokenInvalid();
      // PRF がなければ 400 PRF_UNSUPPORTED、検証の失敗は 400 WEBAUTHN_FAILED（どちらもトークンは消費しない）
      const step = await support.finishRegistration(
        `pairing-register:${tokenHash}`,
        input.response,
        rpId,
        origin,
      );
      if (step.kind === "prf_required") {
        return c.json({ status: "prf_required" as const, options: step.options }, 200);
      }
      const { prfOutput } = step.registered;
      const passkey = support.newPasskey(step.registered, rpId, input.name);
      let consumed: boolean;
      try {
        await support.assertNewCredential(store, passkey.id);
        // 包みを作り終えてから、パスキーの追加と同じトランザクションでトークンを消費する（INV-53）
        const wrap = vault.withDataKey((dk) => wrapDataKey(dk, prfOutput, "passkey", passkey.id));
        consumed = await store.addPasskeyWithPairingToken(passkey, wrap, tokenHash, clock.now());
      } finally {
        prfOutput.fill(0);
      }
      // 同時に別の要求が使った（消費に負けた）なら、パスキーは増えていない
      if (!consumed) throw tokenInvalid();
      const session = await support.startSession(store, c, rpId, "normal", passkey.id);
      await support.record(store, c, "pairing_used", {
        passkeyId: passkey.id,
        sessionId: session.id,
      });
      await support.record(store, c, "register", { passkeyId: passkey.id, sessionId: session.id });
      return c.json({ passkey: toPasskeyView({ ...passkey, lastUsedAt: null }) }, 201);
    });
}
