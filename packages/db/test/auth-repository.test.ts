import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth-hash.ts";
import { DrizzleAuthStore } from "../src/auth-repository.ts";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: ReturnType<typeof openRegistry>;
let store: DrizzleAuthStore;
beforeEach(() => {
  tmp = useTempDataDir("auth-repository");
  db = openRegistry();
  store = new DrizzleAuthStore(db);
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

const T0 = "2026-10-20T09:00:00.000Z";
const T1 = "2026-10-20T10:00:00.000Z";
const T2 = "2026-10-20T11:00:00.000Z";

const passkey = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  publicKey: new Uint8Array([1, 2, 3, 250]),
  counter: 0,
  rpId: "localhost",
  transports: ["internal", "hybrid"] as string[] | null,
  name: "MacBook",
  createdAt: T0,
  ...over,
});

const session = (id: string, tokenHash: string, over: Record<string, unknown> = {}) => ({
  id,
  tokenHash,
  kind: "normal" as const,
  rpId: "localhost",
  passkeyId: null as string | null,
  userAgent: "UA" as string | null,
  now: T0,
  ...over,
});

describe("hashToken", () => {
  it("SHA-256 の hex（既知の値）", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashToken("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(hashToken("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("passkeys", () => {
  it("追加・取得・一覧の往復（公開鍵と transports を保つ）", async () => {
    await store.addPasskey(passkey("pk1"));
    await store.addPasskey(passkey("pk2", { createdAt: T1, transports: null }));
    const got = await store.getPasskey("pk1");
    expect(got).toBeDefined();
    expect(Array.from(got?.publicKey ?? [])).toEqual([1, 2, 3, 250]);
    expect(got?.transports).toEqual(["internal", "hybrid"]);
    expect(got?.lastUsedAt).toBeNull();
    expect((await store.getPasskey("pk2"))?.transports).toBeNull();
    expect((await store.listPasskeys()).map((p) => p.id)).toEqual(["pk1", "pk2"]);
    expect(await store.getPasskey("none")).toBeUndefined();
  });

  it("名前の変更・counter と last_used_at の更新・削除", async () => {
    await store.addPasskey(passkey("pk1"));
    await store.renamePasskey("pk1", "iPhone");
    await store.recordPasskeyUse("pk1", 7, T1);
    const got = await store.getPasskey("pk1");
    expect(got?.name).toBe("iPhone");
    expect(got?.counter).toBe(7);
    expect(got?.lastUsedAt).toBe(T1);
    await store.deletePasskey("pk1");
    expect(await store.getPasskey("pk1")).toBeUndefined();
    expect(await store.listPasskeys()).toEqual([]);
  });

  it("同じ id の追加は失敗する", async () => {
    await store.addPasskey(passkey("pk1"));
    await expect(store.addPasskey(passkey("pk1"))).rejects.toThrow();
  });
});

describe("recovery codes", () => {
  it("有効な行がなければ undefined", async () => {
    expect(await store.getActiveRecoveryCode()).toBeUndefined();
  });

  it("置き換えると古い行が閉じ、有効な行は1つだけ残る（revoked）", async () => {
    await store.replaceRecoveryCode("h1", T0, "revoked");
    const first = await store.getActiveRecoveryCode();
    expect(first?.codeHash).toBe("h1");
    await store.replaceRecoveryCode("h2", T1, "revoked");
    const second = await store.getActiveRecoveryCode();
    expect(second?.codeHash).toBe("h2");
    expect(second?.id).not.toBe(first?.id);
    const rows = db.$client
      .prepare("SELECT code_hash, used_at, revoked_at FROM recovery_codes ORDER BY created_at")
      .all();
    expect(rows).toEqual([
      { code_hash: "h1", used_at: null, revoked_at: T1 },
      { code_hash: "h2", used_at: null, revoked_at: null },
    ]);
  });

  it("closeAs が used なら used_at を付ける", async () => {
    await store.replaceRecoveryCode("h1", T0, "revoked");
    await store.replaceRecoveryCode("h2", T1, "used");
    const rows = db.$client
      .prepare("SELECT code_hash, used_at, revoked_at FROM recovery_codes ORDER BY created_at")
      .all();
    expect(rows).toEqual([
      { code_hash: "h1", used_at: T1, revoked_at: null },
      { code_hash: "h2", used_at: null, revoked_at: null },
    ]);
    const active = db.$client
      .prepare(
        "SELECT count(*) AS n FROM recovery_codes WHERE used_at IS NULL AND revoked_at IS NULL",
      )
      .get() as { n: number };
    expect(active.n).toBe(1);
  });
});

describe("sessions", () => {
  it("作成・ハッシュでの検索・last_seen_at の更新・失効", async () => {
    await store.createSession(session("s1", "th1", { passkeyId: "pk1" }));
    const found = await store.findSessionByTokenHash("th1");
    expect(found).toEqual({
      id: "s1",
      tokenHash: "th1",
      kind: "normal",
      rpId: "localhost",
      passkeyId: "pk1",
      userAgent: "UA",
      createdAt: T0,
      lastSeenAt: T0,
      revokedAt: null,
    });
    expect(await store.findSessionByTokenHash("nope")).toBeUndefined();
    await store.touchSession("s1", T1);
    expect((await store.findSessionByTokenHash("th1"))?.lastSeenAt).toBe(T1);
    await store.revokeSession("s1", T2);
    expect((await store.findSessionByTokenHash("th1"))?.revokedAt).toBe(T2);
    await store.revokeSession("s1", "2026-10-21T00:00:00.000Z");
    expect((await store.findSessionByTokenHash("th1"))?.revokedAt).toBe(T2);
  });

  it("token_hash の重複は失敗する", async () => {
    await store.createSession(session("s1", "th1"));
    await expect(store.createSession(session("s2", "th1"))).rejects.toThrow();
  });

  it("パスキーによる一括失効は対象の（未失効の）セッションだけを失効する", async () => {
    await store.createSession(session("a1", "ta1", { passkeyId: "pkA" }));
    await store.createSession(session("a2", "ta2", { passkeyId: "pkA" }));
    await store.createSession(session("a3", "ta3", { passkeyId: "pkA" }));
    await store.createSession(session("b1", "tb1", { passkeyId: "pkB" }));
    await store.createSession(session("r1", "tr1", { kind: "recovery", passkeyId: null }));
    await store.revokeSession("a3", T0);
    const ids = await store.revokeSessionsByPasskey("pkA", T1);
    expect([...ids].sort()).toEqual(["a1", "a2"]);
    expect((await store.findSessionByTokenHash("ta1"))?.revokedAt).toBe(T1);
    expect((await store.findSessionByTokenHash("ta3"))?.revokedAt).toBe(T0);
    expect((await store.findSessionByTokenHash("tb1"))?.revokedAt).toBeNull();
    expect((await store.findSessionByTokenHash("tr1"))?.revokedAt).toBeNull();
    expect(await store.revokeSessionsByPasskey("pkA", T2)).toEqual([]);
  });

  it("有効なセッションだけを一覧する（失効・アイドル超過・回復の期限）", async () => {
    const now = "2026-10-20T12:00:00.000Z";
    await store.createSession(session("ok", "t1", { now: "2026-10-20T11:00:00.000Z" }));
    await store.createSession(session("idle", "t2", { now: "2026-10-20T03:00:00.000Z" }));
    await store.createSession(session("revoked", "t3", { now: "2026-10-20T11:00:00.000Z" }));
    await store.revokeSession("revoked", "2026-10-20T11:30:00.000Z");
    await store.createSession(
      session("rec-ok", "t4", { kind: "recovery", now: "2026-10-20T11:55:00.000Z" }),
    );
    await store.createSession(
      session("rec-old", "t5", { kind: "recovery", now: "2026-10-20T11:00:00.000Z" }),
    );
    const active = await store.listActiveSessions(now);
    expect(active.map((s) => s.id).sort()).toEqual(["ok", "rec-ok"]);
  });

  it("失効済みで before より古い行だけを掃除する", async () => {
    await store.createSession(session("old", "t1"));
    await store.createSession(session("new", "t2"));
    await store.createSession(session("live", "t3"));
    await store.createSession(session("edge", "t4"));
    await store.revokeSession("old", "2026-10-01T00:00:00.000Z");
    await store.revokeSession("new", "2026-10-19T00:00:00.000Z");
    await store.revokeSession("edge", "2026-10-13T00:00:00.000Z");
    const n = await store.deleteStaleSessions("2026-10-13T00:00:00.000Z");
    expect(n).toBe(1);
    expect(await store.findSessionByTokenHash("t1")).toBeUndefined();
    expect(await store.findSessionByTokenHash("t2")).toBeDefined();
    expect(await store.findSessionByTokenHash("t3")).toBeDefined();
    expect(await store.findSessionByTokenHash("t4")).toBeDefined();
  });
});

describe("auth_events", () => {
  it("追記と新しい順の取得（省略した列は null、detail は JSON の往復）", async () => {
    await store.appendEvent({ id: "e1", occurredAt: T0, kind: "register" });
    await store.appendEvent({
      id: "e2",
      occurredAt: T1,
      kind: "sign_in_failed",
      rpId: "localhost",
      passkeyId: "pk1",
      sessionId: "s1",
      userAgent: "UA",
      detail: { reason: "x", n: 2 },
    });
    await store.appendEvent({ id: "e3", occurredAt: T1, kind: "sign_out" });
    const events = await store.listEvents(10);
    expect(events.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    expect(events[2]).toEqual({
      id: "e1",
      occurredAt: T0,
      kind: "register",
      rpId: null,
      passkeyId: null,
      sessionId: null,
      userAgent: null,
      detail: null,
    });
    expect(events[1]).toMatchObject({
      rpId: "localhost",
      passkeyId: "pk1",
      sessionId: "s1",
      userAgent: "UA",
      detail: { reason: "x", n: 2 },
    });
    expect((await store.listEvents(2)).map((e) => e.id)).toEqual(["e3", "e2"]);
  });

  it("since と kinds での取得（since を含む、新しい順）", async () => {
    await store.appendEvent({ id: "e1", occurredAt: T0, kind: "recovery_failed" });
    await store.appendEvent({ id: "e2", occurredAt: T1, kind: "sign_in" });
    await store.appendEvent({ id: "e3", occurredAt: T1, kind: "recovery_failed" });
    await store.appendEvent({ id: "e4", occurredAt: T2, kind: "recovery_failed" });
    const got = await store.listEventsSince(T1, ["recovery_failed"]);
    expect(got.map((e) => e.id)).toEqual(["e4", "e3"]);
    expect(await store.listEventsSince(T0, [])).toEqual([]);
  });

  it("更新・削除はトリガーで失敗する", async () => {
    await store.appendEvent({ id: "e1", occurredAt: T0, kind: "register" });
    expect(() =>
      db.$client.prepare("UPDATE auth_events SET kind = 'sign_in' WHERE id = 'e1'").run(),
    ).toThrow();
    expect(() => db.$client.prepare("DELETE FROM auth_events WHERE id = 'e1'").run()).toThrow();
    expect(await store.listEvents(10)).toHaveLength(1);
  });
});

describe("pairing tokens", () => {
  const token = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    tokenHash: "ph1",
    rpId: "mac.ts.net",
    now: T0,
    expiresAt: "2026-10-20T09:10:00.000Z",
    ...over,
  });
  const MID = "2026-10-20T09:05:00.000Z";
  const LATE = "2026-10-20T09:10:00.000Z";

  it("有効かの確認は rpId の一致と now < expiresAt", async () => {
    await store.createPairingToken(token());
    expect(await store.isPairingTokenValid("ph1", "mac.ts.net", MID)).toBe(true);
    expect(await store.isPairingTokenValid("ph1", "other.ts.net", MID)).toBe(false);
    expect(await store.isPairingTokenValid("ph1", "mac.ts.net", LATE)).toBe(false);
    expect(await store.isPairingTokenValid("zz", "mac.ts.net", MID)).toBe(false);
  });

  it("消費は単回（2回目は偽）で、確認も偽になる", async () => {
    await store.createPairingToken(token());
    expect(await store.consumePairingToken("ph1", "mac.ts.net", MID)).toBe(true);
    expect(await store.consumePairingToken("ph1", "mac.ts.net", MID)).toBe(false);
    expect(await store.isPairingTokenValid("ph1", "mac.ts.net", MID)).toBe(false);
  });

  it("期限切れ・rpId 違いの消費は偽で、used_at を付けない", async () => {
    await store.createPairingToken(token());
    expect(await store.consumePairingToken("ph1", "mac.ts.net", LATE)).toBe(false);
    expect(await store.consumePairingToken("ph1", "other.ts.net", MID)).toBe(false);
    expect(await store.consumePairingToken("ph1", "mac.ts.net", MID)).toBe(true);
  });

  it("期限切れの削除は expiresAt < before だけ", async () => {
    await store.createPairingToken(token({ id: "p1", tokenHash: "a", expiresAt: T0 }));
    await store.createPairingToken(token({ id: "p2", tokenHash: "b", expiresAt: T1 }));
    await store.createPairingToken(token({ id: "p3", tokenHash: "c", expiresAt: T2 }));
    expect(await store.deleteExpiredPairingTokens(T1)).toBe(1);
    expect(await store.isPairingTokenValid("a", "mac.ts.net", "2026-10-20T08:00:00.000Z")).toBe(
      false,
    );
    expect(await store.isPairingTokenValid("b", "mac.ts.net", "2026-10-20T08:00:00.000Z")).toBe(
      true,
    );
  });
});

describe("app_settings", () => {
  it("未設定は undefined、setSetting で往復し上書きできる", async () => {
    expect(await store.getSetting("remote_host")).toBeUndefined();
    await store.setSetting("remote_host", "mac.ts.net", T0);
    expect(await store.getSetting("remote_host")).toBe("mac.ts.net");
    await store.setSetting("remote_host", "other.ts.net", T1);
    expect(await store.getSetting("remote_host")).toBe("other.ts.net");
  });

  it("getOrCreateMacId は2回目に同じ値を返し、newId を呼ばない", async () => {
    const first = await store.getOrCreateMacId(() => "11111111-1111-4111-8111-111111111111");
    expect(first).toBe("11111111-1111-4111-8111-111111111111");
    let called = false;
    const second = await store.getOrCreateMacId(() => {
      called = true;
      return "other";
    });
    expect(second).toBe(first);
    expect(called).toBe(false);
    expect(await store.getSetting("mac_id")).toBe(first);
  });
});
