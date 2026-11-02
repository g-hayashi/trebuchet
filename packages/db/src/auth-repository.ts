import { randomUUID } from "node:crypto";
import {
  type AppSettingKey,
  type AuthEvent,
  type AuthEventKind,
  type AuthStore,
  isSessionActive,
  type KeyWrap,
  type NewAuthEvent,
  type NewPasskey,
  type NewSession,
  type Passkey,
  type Session,
  type WrappedKey,
} from "@trebuchet/domain";
import type { RemoteSettings } from "@trebuchet/schema";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { rowidOf } from "./internal.ts";
import {
  authEvents,
  keyWraps,
  pairingTokens,
  passkeys,
  remoteSettings,
  sessions,
} from "./schema/auth.ts";
import { appSettings } from "./schema/registry.ts";
import type { AuthDb, RegistryDb } from "./tenant-store.ts";

type PasskeyRow = typeof passkeys.$inferSelect;
type KeyWrapRow = typeof keyWraps.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type EventRow = typeof authEvents.$inferSelect;
/** auth.sqlite、またはそのトランザクション */
type AuthConn = Pick<AuthDb, "select" | "insert" | "delete">;

function toPasskey(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    publicKey: new Uint8Array(r.publicKey),
    counter: r.counter,
    rpId: r.rpId,
    transports: r.transports === null ? null : (JSON.parse(r.transports) as string[]),
    name: r.name,
    prfSalt: new Uint8Array(r.prfSalt),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  };
}

function toKeyWrap(r: KeyWrapRow): KeyWrap {
  return {
    id: r.id,
    kind: r.kind,
    credentialId: r.credentialId,
    salt: new Uint8Array(r.salt),
    iv: new Uint8Array(r.iv),
    tag: new Uint8Array(r.tag),
    wrapped: new Uint8Array(r.wrapped),
    createdAt: r.createdAt,
  };
}

function wrapRow(
  kind: KeyWrap["kind"],
  credentialId: string | null,
  w: WrappedKey,
  createdAt: string,
): KeyWrapRow {
  return {
    id: randomUUID(),
    kind,
    credentialId,
    salt: Buffer.from(w.salt),
    iv: Buffer.from(w.iv),
    tag: Buffer.from(w.tag),
    wrapped: Buffer.from(w.wrapped),
    createdAt,
  };
}

function hasRecoveryWrap(conn: AuthConn): boolean {
  return (
    conn.select({ id: keyWraps.id }).from(keyWraps).where(eq(keyWraps.kind, "recovery")).get() !==
    undefined
  );
}

/** パスキーとその包みを入れる（呼び出し側のトランザクションの中で） */
function insertPasskeyWithWrap(conn: AuthConn, p: NewPasskey, w: WrappedKey): void {
  conn
    .insert(passkeys)
    .values({
      id: p.id,
      publicKey: Buffer.from(p.publicKey),
      counter: p.counter,
      rpId: p.rpId,
      transports: p.transports === null ? null : JSON.stringify(p.transports),
      name: p.name,
      prfSalt: Buffer.from(p.prfSalt),
      createdAt: p.createdAt,
      lastUsedAt: null,
    })
    .run();
  conn
    .insert(keyWraps)
    .values(wrapRow("passkey", p.id, w, p.createdAt))
    .run();
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    tokenHash: r.tokenHash,
    kind: r.kind,
    rpId: r.rpId,
    passkeyId: r.passkeyId,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
  };
}

function toEvent(r: EventRow): AuthEvent {
  return {
    id: r.id,
    occurredAt: r.occurredAt,
    kind: r.kind,
    rpId: r.rpId,
    passkeyId: r.passkeyId,
    sessionId: r.sessionId,
    userAgent: r.userAgent,
    detail: r.detail === null ? null : (JSON.parse(r.detail) as AuthEvent["detail"]),
  };
}

/** 新しい順（同じ時刻は後から追記した方が先）。auth_events は追記のみなので rowid が追記の順 */
const newestFirst = [desc(authEvents.occurredAt), desc(rowidOf(authEvents))] as const;

/**
 * AuthStore の Drizzle（better-sqlite3-multiple-ciphers）による実装。パスキー・包み・セッション・記録は
 * auth.sqlite（リモートの設定・ペアリングのトークンを含む。施錠中も使える）、app_settings は registry
 * （`registry()` を呼ぶたびに開くので、施錠中は VaultLockedError）。ドライバーは同期なので、各メソッドは同期に実行して Promise で返す
 */
export class DrizzleAuthStore implements AuthStore {
  private readonly db: AuthDb;
  private readonly registry: () => RegistryDb;

  constructor(db: AuthDb, registry: () => RegistryDb) {
    this.db = db;
    this.registry = registry;
  }

  // パスキー

  async listPasskeys(): Promise<Passkey[]> {
    return this.db
      .select()
      .from(passkeys)
      .orderBy(passkeys.createdAt, rowidOf(passkeys))
      .all()
      .map(toPasskey);
  }

  async getPasskey(id: string): Promise<Passkey | undefined> {
    const row = this.db.select().from(passkeys).where(eq(passkeys.id, id)).get();
    return row ? toPasskey(row) : undefined;
  }

  /** 設定前なら失敗。パスキーと包みを 1 トランザクションで入れる（INV-53） */
  async addPasskey(p: NewPasskey, wrap: WrappedKey): Promise<void> {
    this.db.transaction((tx) => {
      if (!hasRecoveryWrap(tx)) throw new Error("vault is not initialized");
      insertPasskeyWithWrap(tx, p, wrap);
    });
  }

  async renamePasskey(id: string, name: string): Promise<void> {
    this.db.update(passkeys).set({ name }).where(eq(passkeys.id, id)).run();
  }

  /** 包みは外部キー（ON DELETE CASCADE）で同時に消える。最後の 1 本は消さない（INV-53） */
  async deletePasskey(id: string): Promise<void> {
    this.db.transaction((tx) => {
      const exists = tx.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.id, id)).get();
      if (exists === undefined) return;
      const total = tx.select({ n: count() }).from(passkeys).get()?.n ?? 0;
      if (total <= 1) throw new Error("cannot delete the last passkey");
      tx.delete(passkeys).where(eq(passkeys.id, id)).run();
    });
  }

  async recordPasskeyUse(id: string, counter: number, at: string): Promise<void> {
    this.db.update(passkeys).set({ counter, lastUsedAt: at }).where(eq(passkeys.id, id)).run();
  }

  // 鍵の包み（008 の D1・D2）

  /** 設定済み（recovery の包みがある）なら失敗。3 行を 1 トランザクションで入れる */
  async initializeVault(
    passkey: NewPasskey,
    passkeyWrap: WrappedKey,
    recoveryWrap: WrappedKey,
  ): Promise<void> {
    this.db.transaction((tx) => {
      if (hasRecoveryWrap(tx)) throw new Error("vault is already initialized");
      insertPasskeyWithWrap(tx, passkey, passkeyWrap);
      tx.insert(keyWraps)
        .values(wrapRow("recovery", null, recoveryWrap, passkey.createdAt))
        .run();
    });
  }

  async getPasskeyWrap(credentialId: string): Promise<KeyWrap | undefined> {
    const row = this.db
      .select()
      .from(keyWraps)
      .where(and(eq(keyWraps.kind, "passkey"), eq(keyWraps.credentialId, credentialId)))
      .get();
    return row ? toKeyWrap(row) : undefined;
  }

  async getRecoveryWrap(): Promise<KeyWrap | undefined> {
    const row = this.db.select().from(keyWraps).where(eq(keyWraps.kind, "recovery")).get();
    return row ? toKeyWrap(row) : undefined;
  }

  /** 古い行を消してから新しい行を入れる（部分 UNIQUE の順序）。設定前なら失敗。1 トランザクション */
  async replaceRecoveryWrap(wrap: WrappedKey, now: string): Promise<void> {
    this.db.transaction((tx) => {
      if (!hasRecoveryWrap(tx)) throw new Error("vault is not initialized");
      tx.delete(keyWraps).where(eq(keyWraps.kind, "recovery")).run();
      tx.insert(keyWraps)
        .values(wrapRow("recovery", null, wrap, now))
        .run();
    });
  }

  // セッション

  async createSession(s: NewSession): Promise<void> {
    this.db
      .insert(sessions)
      .values({
        id: s.id,
        tokenHash: s.tokenHash,
        kind: s.kind,
        rpId: s.rpId,
        passkeyId: s.passkeyId,
        userAgent: s.userAgent,
        createdAt: s.now,
        lastSeenAt: s.now,
        revokedAt: null,
      })
      .run();
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const row = this.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get();
    return row ? toSession(row) : undefined;
  }

  async touchSession(id: string, at: string): Promise<void> {
    this.db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, id)).run();
  }

  /** すでに失効済みなら最初の失効の時刻を保つ */
  async revokeSession(id: string, at: string): Promise<void> {
    this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .run();
  }

  async revokeSessionsByPasskey(passkeyId: string, at: string): Promise<string[]> {
    return this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(and(eq(sessions.passkeyId, passkeyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id })
      .all()
      .map((r) => r.id);
  }

  /** 有効の判定はドメインの isSessionActive に合わせる（失効していない行を取り出して判定） */
  async listActiveSessions(now: string): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(isNull(sessions.revokedAt))
      .orderBy(sessions.createdAt, rowidOf(sessions))
      .all()
      .map(toSession)
      .filter((s) => isSessionActive(s, now));
  }

  async deleteStaleSessions(before: string): Promise<number> {
    return this.db
      .delete(sessions)
      .where(lt(sessions.revokedAt, before))
      .returning({ id: sessions.id })
      .all().length;
  }

  async deleteAllSessions(): Promise<number> {
    return this.db.delete(sessions).returning({ id: sessions.id }).all().length;
  }

  // 認証の記録（追記のみ）

  async appendEvent(e: NewAuthEvent): Promise<void> {
    this.db
      .insert(authEvents)
      .values({
        id: e.id,
        occurredAt: e.occurredAt,
        kind: e.kind,
        rpId: e.rpId ?? null,
        passkeyId: e.passkeyId ?? null,
        sessionId: e.sessionId ?? null,
        userAgent: e.userAgent ?? null,
        detail: e.detail == null ? null : JSON.stringify(e.detail),
      })
      .run();
  }

  async listEvents(limit: number): Promise<AuthEvent[]> {
    return this.db
      .select()
      .from(authEvents)
      .orderBy(...newestFirst)
      .limit(limit)
      .all()
      .map(toEvent);
  }

  async listEventsSince(since: string, kinds: AuthEventKind[]): Promise<AuthEvent[]> {
    if (kinds.length === 0) return [];
    return this.db
      .select()
      .from(authEvents)
      .where(and(gte(authEvents.occurredAt, since), inArray(authEvents.kind, kinds)))
      .orderBy(...newestFirst)
      .all()
      .map(toEvent);
  }

  // ペアリングのトークン（auth.sqlite。施錠中も使える）

  async createPairingToken(t: {
    id: string;
    tokenHash: string;
    rpId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    this.db
      .insert(pairingTokens)
      .values({
        id: t.id,
        tokenHash: t.tokenHash,
        rpId: t.rpId,
        createdAt: t.now,
        expiresAt: t.expiresAt,
        usedAt: null,
      })
      .run();
  }

  async isPairingTokenValid(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    const row = this.db
      .select({ id: pairingTokens.id })
      .from(pairingTokens)
      .where(
        and(
          eq(pairingTokens.tokenHash, tokenHash),
          eq(pairingTokens.rpId, rpId),
          isNull(pairingTokens.usedAt),
          sql`${now} < ${pairingTokens.expiresAt}`,
        ),
      )
      .get();
    return row !== undefined;
  }

  /** `UPDATE … WHERE used_at IS NULL AND now < expires_at` の結果で単回を保証する */
  async consumePairingToken(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    const rows = this.db
      .update(pairingTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(pairingTokens.tokenHash, tokenHash),
          eq(pairingTokens.rpId, rpId),
          isNull(pairingTokens.usedAt),
          sql`${now} < ${pairingTokens.expiresAt}`,
        ),
      )
      .returning({ id: pairingTokens.id })
      .all();
    return rows.length > 0;
  }

  async deleteExpiredPairingTokens(before: string): Promise<number> {
    return this.db
      .delete(pairingTokens)
      .where(lt(pairingTokens.expiresAt, before))
      .returning({ id: pairingTokens.id })
      .all().length;
  }

  // リモートの設定（auth.sqlite。施錠中も使える）

  async getRemoteSettings(): Promise<RemoteSettings> {
    const row = this.db.select().from(remoteSettings).where(eq(remoteSettings.id, 1)).get();
    return row === undefined
      ? { enabled: false, host: null }
      : { enabled: row.enabled === 1, host: row.host };
  }

  /** CHECK（`*.ts.net`、有効なら名前が必要）を破れば失敗し、何も書かない */
  async setRemoteSettings(settings: RemoteSettings, now: string): Promise<void> {
    const value = { enabled: settings.enabled ? 1 : 0, host: settings.host, updatedAt: now };
    this.db
      .insert(remoteSettings)
      .values({ id: 1, ...value })
      .onConflictDoUpdate({ target: remoteSettings.id, set: value })
      .run();
  }

  // アプリの設定

  async getSetting(key: AppSettingKey): Promise<string | undefined> {
    return this.registry()
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get()?.value;
  }

  async setSetting(key: AppSettingKey, value: string, now: string): Promise<void> {
    this.registry()
      .insert(appSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
      .run();
  }

  /** 存在しなければ newId() で作って保存する（R14）。同期の区間で読んで書くので競合しない */
  async getOrCreateMacId(newId: () => string): Promise<string> {
    const existing = await this.getSetting("mac_id");
    if (existing !== undefined) return existing;
    const id = newId();
    await this.setSetting("mac_id", id, new Date().toISOString());
    return id;
  }
}
