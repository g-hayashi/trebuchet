import { randomUUID } from "node:crypto";
import {
  type AppSettingKey,
  type AuthEvent,
  type AuthEventKind,
  type AuthStore,
  isSessionActive,
  type NewAuthEvent,
  type NewPasskey,
  type NewSession,
  type Passkey,
  type Session,
} from "@trebuchet/domain";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { rowidOf } from "./internal.ts";
import {
  appSettings,
  authEvents,
  pairingTokens,
  passkeys,
  recoveryCodes,
  sessions,
} from "./schema/registry.ts";
import type { RegistryDb } from "./tenant-store.ts";

type PasskeyRow = typeof passkeys.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type EventRow = typeof authEvents.$inferSelect;

function toPasskey(r: PasskeyRow): Passkey {
  return {
    id: r.id,
    publicKey: new Uint8Array(r.publicKey),
    counter: r.counter,
    rpId: r.rpId,
    transports: r.transports === null ? null : (JSON.parse(r.transports) as string[]),
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  };
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
 * AuthStore の Drizzle（better-sqlite3）による実装。registry の DB を使う。
 * better-sqlite3 は同期なので、各メソッドは同期に実行して Promise で返す
 */
export class DrizzleAuthStore implements AuthStore {
  private readonly db: RegistryDb;

  constructor(db: RegistryDb) {
    this.db = db;
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

  async addPasskey(p: NewPasskey): Promise<void> {
    this.db
      .insert(passkeys)
      .values({
        id: p.id,
        publicKey: Buffer.from(p.publicKey),
        counter: p.counter,
        rpId: p.rpId,
        transports: p.transports === null ? null : JSON.stringify(p.transports),
        name: p.name,
        createdAt: p.createdAt,
        lastUsedAt: null,
      })
      .run();
  }

  async renamePasskey(id: string, name: string): Promise<void> {
    this.db.update(passkeys).set({ name }).where(eq(passkeys.id, id)).run();
  }

  async deletePasskey(id: string): Promise<void> {
    this.db.delete(passkeys).where(eq(passkeys.id, id)).run();
  }

  async recordPasskeyUse(id: string, counter: number, at: string): Promise<void> {
    this.db.update(passkeys).set({ counter, lastUsedAt: at }).where(eq(passkeys.id, id)).run();
  }

  // 回復コード

  async getActiveRecoveryCode(): Promise<{ id: string; codeHash: string } | undefined> {
    return this.db
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(and(isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)))
      .get();
  }

  /** 古い有効な行を閉じてから新しい行を入れる（部分 UNIQUE インデックスの順序）。1 トランザクション */
  async replaceRecoveryCode(
    newCodeHash: string,
    now: string,
    closeAs: "used" | "revoked",
  ): Promise<void> {
    this.db.transaction((tx) => {
      tx.update(recoveryCodes)
        .set(closeAs === "used" ? { usedAt: now } : { revokedAt: now })
        .where(and(isNull(recoveryCodes.usedAt), isNull(recoveryCodes.revokedAt)))
        .run();
      tx.insert(recoveryCodes)
        .values({ id: randomUUID(), codeHash: newCodeHash, createdAt: now })
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

  // ペアリングのトークン

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

  // アプリの設定

  async getSetting(key: AppSettingKey): Promise<string | undefined> {
    return this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .get()?.value;
  }

  async setSetting(key: AppSettingKey, value: string, now: string): Promise<void> {
    this.db
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
