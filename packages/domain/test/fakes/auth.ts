import type { RemoteSettings } from "@trebuchet/schema";
import { isSessionActive } from "../../src/auth/session.ts";
import type {
  AppSettingKey,
  AuthEvent,
  AuthEventKind,
  BackupRun,
  KeyWrap,
  NewAuthEvent,
  NewBackupRun,
  NewPasskey,
  NewSession,
  Passkey,
  Session,
  WrappedKey,
} from "../../src/auth/types.ts";
import type { AuthStore, BackupStore, SecretStore } from "../../src/ports.ts";

/** メモリ上の SecretStore（キーチェーンの代わり） */
export class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const copyWrap = (w: KeyWrap): KeyWrap => ({
  ...w,
  salt: Uint8Array.from(w.salt),
  iv: Uint8Array.from(w.iv),
  tag: Uint8Array.from(w.tag),
  wrapped: Uint8Array.from(w.wrapped),
});

interface FakePairingToken {
  id: string;
  tokenHash: string;
  rpId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

/** メモリ上の AuthStore。DB の実装と同じ振る舞い（追記のみの記録、単回のトークン）を持つ */
export class FakeAuthStore implements AuthStore {
  passkeys: Passkey[] = [];
  keyWraps: KeyWrap[] = [];
  sessions: Session[] = [];
  events: AuthEvent[] = [];
  pairingTokens: FakePairingToken[] = [];
  settings = new Map<AppSettingKey, { value: string; updatedAt: string }>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async listPasskeys(): Promise<Passkey[]> {
    return this.passkeys.map((p) => ({ ...p }));
  }
  async getPasskey(id: string): Promise<Passkey | undefined> {
    const p = this.passkeys.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }
  /** DB の実装と同じく、パスキーと包みを同時に入れる（INV-53） */
  private insertPasskey(passkey: NewPasskey, wrap: WrappedKey): void {
    if (this.passkeys.some((p) => p.id === passkey.id)) {
      throw new Error(`duplicate passkey: ${passkey.id}`);
    }
    this.passkeys.push({ ...passkey, lastUsedAt: null });
    this.keyWraps.push(this.newWrap("passkey", passkey.id, wrap, passkey.createdAt));
  }
  private newWrap(
    kind: KeyWrap["kind"],
    credentialId: string | null,
    wrap: WrappedKey,
    createdAt: string,
  ): KeyWrap {
    return copyWrap({ id: this.nextId("kw"), kind, credentialId, createdAt, ...wrap });
  }
  async addPasskey(passkey: NewPasskey, wrap: WrappedKey): Promise<void> {
    if (!this.keyWraps.some((w) => w.kind === "recovery")) {
      throw new Error("vault is not initialized");
    }
    this.insertPasskey(passkey, wrap);
  }
  async renamePasskey(id: string, name: string): Promise<void> {
    const p = this.passkeys.find((x) => x.id === id);
    if (p) p.name = name;
  }
  async deletePasskey(id: string): Promise<void> {
    if (!this.passkeys.some((p) => p.id === id)) return;
    if (this.passkeys.length === 1) throw new Error("cannot delete the last passkey");
    this.passkeys = this.passkeys.filter((p) => p.id !== id);
    this.keyWraps = this.keyWraps.filter((w) => w.credentialId !== id);
  }
  async recordPasskeyUse(id: string, counter: number, at: string): Promise<void> {
    const p = this.passkeys.find((x) => x.id === id);
    if (p) {
      p.counter = counter;
      p.lastUsedAt = at;
    }
  }

  async initializeVault(
    passkey: NewPasskey,
    passkeyWrap: WrappedKey,
    recoveryWrap: WrappedKey,
  ): Promise<void> {
    if (this.keyWraps.some((w) => w.kind === "recovery")) {
      throw new Error("vault is already initialized");
    }
    this.insertPasskey(passkey, passkeyWrap);
    this.keyWraps.push(this.newWrap("recovery", null, recoveryWrap, passkey.createdAt));
  }
  async getPasskeyWrap(credentialId: string): Promise<KeyWrap | undefined> {
    const w = this.keyWraps.find((x) => x.kind === "passkey" && x.credentialId === credentialId);
    return w ? copyWrap(w) : undefined;
  }
  async getRecoveryWrap(): Promise<KeyWrap | undefined> {
    const w = this.keyWraps.find((x) => x.kind === "recovery");
    return w ? copyWrap(w) : undefined;
  }
  async replaceRecoveryWrap(wrap: WrappedKey, now: string): Promise<void> {
    if (!this.keyWraps.some((w) => w.kind === "recovery")) {
      throw new Error("vault is not initialized");
    }
    this.keyWraps = this.keyWraps.filter((w) => w.kind !== "recovery");
    this.keyWraps.push(this.newWrap("recovery", null, wrap, now));
  }

  async createSession(s: NewSession): Promise<void> {
    if (this.sessions.some((x) => x.tokenHash === s.tokenHash)) {
      throw new Error("duplicate session token_hash");
    }
    this.sessions.push({
      id: s.id,
      tokenHash: s.tokenHash,
      kind: s.kind,
      rpId: s.rpId,
      passkeyId: s.passkeyId,
      userAgent: s.userAgent,
      createdAt: s.now,
      lastSeenAt: s.now,
      revokedAt: null,
    });
  }
  async findSessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const s = this.sessions.find((x) => x.tokenHash === tokenHash);
    return s ? { ...s } : undefined;
  }
  async touchSession(id: string, at: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) s.lastSeenAt = at;
  }
  async revokeSession(id: string, at: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s && s.revokedAt === null) s.revokedAt = at;
  }
  async revokeSessionsByPasskey(passkeyId: string, at: string): Promise<string[]> {
    const ids: string[] = [];
    for (const s of this.sessions) {
      if (s.passkeyId === passkeyId && s.revokedAt === null) {
        s.revokedAt = at;
        ids.push(s.id);
      }
    }
    return ids;
  }
  async listActiveSessions(now: string): Promise<Session[]> {
    return this.sessions.filter((s) => isSessionActive(s, now)).map((s) => ({ ...s }));
  }
  async deleteStaleSessions(before: string): Promise<number> {
    const keep = this.sessions.filter((s) => s.revokedAt === null || s.revokedAt >= before);
    const n = this.sessions.length - keep.length;
    this.sessions = keep;
    return n;
  }
  async deleteAllSessions(): Promise<number> {
    const n = this.sessions.length;
    this.sessions = [];
    return n;
  }

  async appendEvent(e: NewAuthEvent): Promise<void> {
    this.events.push({
      id: e.id,
      occurredAt: e.occurredAt,
      kind: e.kind,
      rpId: e.rpId ?? null,
      passkeyId: e.passkeyId ?? null,
      sessionId: e.sessionId ?? null,
      userAgent: e.userAgent ?? null,
      detail: e.detail ?? null,
    });
  }
  private newestFirst(): AuthEvent[] {
    return this.events
      .map((e, i) => ({ e, i }))
      .sort((a, b) =>
        a.e.occurredAt < b.e.occurredAt ? 1 : a.e.occurredAt > b.e.occurredAt ? -1 : b.i - a.i,
      )
      .map((x) => ({ ...x.e }));
  }
  async listEvents(limit: number): Promise<AuthEvent[]> {
    return this.newestFirst().slice(0, limit);
  }
  async listEventsSince(since: string, kinds: AuthEventKind[]): Promise<AuthEvent[]> {
    return this.newestFirst().filter((e) => e.occurredAt >= since && kinds.includes(e.kind));
  }

  async createPairingToken(t: {
    id: string;
    tokenHash: string;
    rpId: string;
    now: string;
    expiresAt: string;
  }): Promise<void> {
    if (this.pairingTokens.some((x) => x.tokenHash === t.tokenHash)) {
      throw new Error("duplicate pairing token_hash");
    }
    this.pairingTokens.push({
      id: t.id,
      tokenHash: t.tokenHash,
      rpId: t.rpId,
      createdAt: t.now,
      expiresAt: t.expiresAt,
      usedAt: null,
    });
  }
  private findValidPairing(tokenHash: string, rpId: string, now: string) {
    return this.pairingTokens.find(
      (t) => t.tokenHash === tokenHash && t.rpId === rpId && t.usedAt === null && now < t.expiresAt,
    );
  }
  async isPairingTokenValid(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    return this.findValidPairing(tokenHash, rpId, now) !== undefined;
  }
  async consumePairingToken(tokenHash: string, rpId: string, now: string): Promise<boolean> {
    const t = this.findValidPairing(tokenHash, rpId, now);
    if (!t) return false;
    t.usedAt = now;
    return true;
  }
  async addPasskeyWithPairingToken(
    passkey: NewPasskey,
    wrap: WrappedKey,
    tokenHash: string,
    now: string,
  ): Promise<boolean> {
    if (!this.keyWraps.some((w) => w.kind === "recovery")) {
      throw new Error("vault is not initialized");
    }
    const t = this.findValidPairing(tokenHash, passkey.rpId, now);
    if (!t) return false;
    this.insertPasskey(passkey, wrap); // 失敗すれば例外で、トークンは使用済みにならない
    t.usedAt = now;
    return true;
  }
  async deleteExpiredPairingTokens(before: string): Promise<number> {
    const keep = this.pairingTokens.filter((t) => t.expiresAt >= before);
    const n = this.pairingTokens.length - keep.length;
    this.pairingTokens = keep;
    return n;
  }

  remote: RemoteSettings = { enabled: false, host: null };
  async getRemoteSettings(): Promise<RemoteSettings> {
    return { ...this.remote };
  }
  async setRemoteSettings(settings: RemoteSettings, _now: string): Promise<void> {
    if (settings.host !== null && !/^(?:[^.]+\.)+ts\.net$/i.test(settings.host)) {
      throw new Error("remote host must be *.ts.net");
    }
    if (settings.enabled && settings.host === null) throw new Error("remote host required");
    this.remote = { ...settings };
  }

  async getSetting(key: AppSettingKey): Promise<string | undefined> {
    return this.settings.get(key)?.value;
  }
  async setSetting(key: AppSettingKey, value: string, now: string): Promise<void> {
    this.settings.set(key, { value, updatedAt: now });
  }
  async getOrCreateMacId(newId: () => string): Promise<string> {
    const existing = this.settings.get("mac_id");
    if (existing) return existing.value;
    const id = newId();
    this.settings.set("mac_id", { value: id, updatedAt: "" });
    return id;
  }
}

/** メモリ上の BackupStore（backup_runs だけ） */
export class FakeBackupStore implements BackupStore {
  runs: BackupRun[] = [];
  async recordRun(run: NewBackupRun): Promise<void> {
    this.runs.push({ ...run });
  }
  private newestFirst(): BackupRun[] {
    return [...this.runs].reverse();
  }
  async getLastRun(): Promise<BackupRun | undefined> {
    return this.newestFirst()[0];
  }
  async getLastCheck(): Promise<BackupRun | undefined> {
    return this.newestFirst().find((r) => r.status === "succeeded" || r.status === "skipped");
  }
  async getLastSuccess(): Promise<BackupRun | undefined> {
    return this.newestFirst().find((r) => r.status === "succeeded");
  }
  async listRuns(limit: number): Promise<BackupRun[]> {
    return this.newestFirst().slice(0, limit);
  }
}
