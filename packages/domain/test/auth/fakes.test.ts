import { describe, expect, it } from "vitest";
import type { NewBackupRun } from "../../src/auth/types.ts";
import { FakeAuthStore, FakeBackupStore, FakeSecretStore } from "../fakes.ts";

const T = (n: number) => new Date(Date.parse("2026-10-20T00:00:00.000Z") + n * 1000).toISOString();

const newPasskey = (id: string, rpId = "localhost") => ({
  id,
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  rpId,
  transports: ["internal"],
  name: `key ${id}`,
  prfSalt: new Uint8Array(32).fill(9),
  createdAt: T(0),
});
const wrap = (byte: number) => ({
  salt: new Uint8Array(32).fill(byte),
  iv: new Uint8Array(12).fill(byte),
  tag: new Uint8Array(16).fill(byte),
  wrapped: new Uint8Array(32).fill(byte),
});
const newSession = (
  id: string,
  kind: "normal" | "recovery" = "normal",
  passkeyId: string | null = null,
) => ({
  id,
  tokenHash: `h-${id}`,
  kind,
  rpId: "localhost",
  passkeyId,
  userAgent: "UA",
  now: T(0),
});

describe("FakeSecretStore", () => {
  it("set / get / delete の往復", async () => {
    const s = new FakeSecretStore();
    expect(await s.get("k")).toBeUndefined();
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });
});

describe("FakeAuthStore", () => {
  it("パスキー: 追加・取得・名前変更・利用の記録・削除", async () => {
    const s = new FakeAuthStore();
    await s.initializeVault(newPasskey("a"), wrap(1), wrap(2));
    await s.addPasskey(newPasskey("b", "x.ts.net"), wrap(3));
    expect((await s.listPasskeys()).map((p) => p.id)).toEqual(["a", "b"]);
    expect((await s.getPasskey("a"))?.lastUsedAt).toBeNull();
    expect(Array.from((await s.getPasskey("a"))?.prfSalt ?? [])).toEqual(Array(32).fill(9));
    await s.renamePasskey("a", "新しい名前");
    await s.recordPasskeyUse("a", 7, T(5));
    const a = await s.getPasskey("a");
    expect(a).toMatchObject({ name: "新しい名前", counter: 7, lastUsedAt: T(5) });
    await s.deletePasskey("a");
    expect(await s.getPasskey("a")).toBeUndefined();
  });

  it("鍵の包み: 初回の設定で passkey と recovery の包みが入り、設定は 1 回だけ", async () => {
    const s = new FakeAuthStore();
    expect(await s.getRecoveryWrap()).toBeUndefined();
    await s.initializeVault(newPasskey("a"), wrap(1), wrap(2));
    expect(await s.getPasskeyWrap("a")).toMatchObject({
      kind: "passkey",
      credentialId: "a",
      createdAt: T(0),
    });
    expect(Array.from((await s.getPasskeyWrap("a"))?.wrapped ?? [])).toEqual(Array(32).fill(1));
    expect(await s.getRecoveryWrap()).toMatchObject({ kind: "recovery", credentialId: null });
    await expect(s.initializeVault(newPasskey("b"), wrap(1), wrap(2))).rejects.toThrow();
    expect((await s.listPasskeys()).map((p) => p.id)).toEqual(["a"]);
  });

  it("鍵の包み: 設定前の addPasskey・replaceRecoveryWrap は失敗する", async () => {
    const s = new FakeAuthStore();
    await expect(s.addPasskey(newPasskey("a"), wrap(1))).rejects.toThrow();
    await expect(s.replaceRecoveryWrap(wrap(2), T(0))).rejects.toThrow();
    expect(await s.listPasskeys()).toEqual([]);
    expect(await s.getRecoveryWrap()).toBeUndefined();
  });

  it("鍵の包み: recovery の置き換えは 1 行のまま、パスキーの削除で包みも消え、最後の 1 本は消せない", async () => {
    const s = new FakeAuthStore();
    await s.initializeVault(newPasskey("a"), wrap(1), wrap(2));
    await s.addPasskey(newPasskey("b"), wrap(3));
    const before = await s.getRecoveryWrap();
    await s.replaceRecoveryWrap(wrap(4), T(1));
    const after = await s.getRecoveryWrap();
    expect(after?.id).not.toBe(before?.id);
    expect(Array.from(after?.wrapped ?? [])).toEqual(Array(32).fill(4));
    expect(s.keyWraps.filter((w) => w.kind === "recovery")).toHaveLength(1);
    await s.deletePasskey("a");
    expect(await s.getPasskeyWrap("a")).toBeUndefined();
    await expect(s.deletePasskey("b")).rejects.toThrow();
    expect(await s.getPasskeyWrap("b")).toBeDefined();
  });

  it("セッション: 作成・検索・touch・失効・一覧・掃除", async () => {
    const s = new FakeAuthStore();
    await s.createSession(newSession("s1"));
    expect(await s.findSessionByTokenHash("h-s1")).toMatchObject({
      id: "s1",
      createdAt: T(0),
      lastSeenAt: T(0),
      revokedAt: null,
    });
    expect(await s.findSessionByTokenHash("nope")).toBeUndefined();
    await s.touchSession("s1", T(10));
    expect((await s.findSessionByTokenHash("h-s1"))?.lastSeenAt).toBe(T(10));
    expect((await s.listActiveSessions(T(11))).map((x) => x.id)).toEqual(["s1"]);
    await s.revokeSession("s1", T(20));
    expect(await s.listActiveSessions(T(21))).toEqual([]);
    expect(await s.deleteStaleSessions(T(20))).toBe(0);
    expect(await s.deleteStaleSessions(T(21))).toBe(1);
    expect(await s.findSessionByTokenHash("h-s1")).toBeUndefined();
  });

  it("セッションの全削除（008 の D3: 起動時・施錠時）は失効の有無・種類によらず全部消し、件数を返す", async () => {
    const s = new FakeAuthStore();
    await s.createSession(newSession("s1"));
    await s.createSession(newSession("s2", "recovery"));
    await s.createSession(newSession("s3"));
    await s.revokeSession("s3", T(1));
    expect(await s.deleteAllSessions()).toBe(3);
    expect(await s.listActiveSessions(T(2))).toEqual([]);
    expect(await s.findSessionByTokenHash("h-s3")).toBeUndefined();
    expect(await s.deleteAllSessions()).toBe(0);
  });

  it("パスキーによる一括失効は対象のセッションの id だけを返す", async () => {
    const s = new FakeAuthStore();
    await s.createSession(newSession("s1", "normal", "pk1"));
    await s.createSession(newSession("s2", "normal", "pk1"));
    await s.createSession(newSession("s3", "normal", "pk2"));
    await s.revokeSession("s2", T(1));
    expect(await s.revokeSessionsByPasskey("pk1", T(2))).toEqual(["s1"]);
    expect((await s.listActiveSessions(T(3))).map((x) => x.id)).toEqual(["s3"]);
  });

  it("認証の記録: 新しい順、since と kinds で絞る", async () => {
    const s = new FakeAuthStore();
    const ev = (id: string, kind: "sign_in" | "recovery_failed", n: number) => ({
      id,
      occurredAt: T(n),
      kind,
    });
    await s.appendEvent(ev("e1", "recovery_failed", 1));
    await s.appendEvent(ev("e2", "sign_in", 2));
    await s.appendEvent({ ...ev("e3", "recovery_failed", 3), rpId: "localhost", detail: { a: 1 } });
    expect((await s.listEvents(2)).map((e) => e.id)).toEqual(["e3", "e2"]);
    expect((await s.listEvents(10))[0]).toMatchObject({
      rpId: "localhost",
      passkeyId: null,
      detail: { a: 1 },
    });
    const since = await s.listEventsSince(T(2), ["recovery_failed"]);
    expect(since.map((e) => e.id)).toEqual(["e3"]);
  });

  it("ペアリングのトークン: 検証・単回の消費・期限・掃除", async () => {
    const s = new FakeAuthStore();
    await s.createPairingToken({
      id: "p1",
      tokenHash: "th",
      rpId: "x.ts.net",
      now: T(0),
      expiresAt: T(600),
    });
    expect(await s.isPairingTokenValid("th", "x.ts.net", T(1))).toBe(true);
    expect(await s.isPairingTokenValid("th", "y.ts.net", T(1))).toBe(false);
    expect(await s.isPairingTokenValid("th", "x.ts.net", T(600))).toBe(false);
    expect(await s.consumePairingToken("th", "x.ts.net", T(1))).toBe(true);
    expect(await s.consumePairingToken("th", "x.ts.net", T(2))).toBe(false);
    await s.createPairingToken({
      id: "p2",
      tokenHash: "t2",
      rpId: "x.ts.net",
      now: T(0),
      expiresAt: T(10),
    });
    expect(await s.consumePairingToken("t2", "x.ts.net", T(10))).toBe(false);
    expect(await s.deleteExpiredPairingTokens(T(10))).toBe(0);
    expect(await s.deleteExpiredPairingTokens(T(11))).toBe(1);
  });

  it("設定: 未設定は undefined、往復、mac_id は 2 回目で同じ値", async () => {
    const s = new FakeAuthStore();
    expect(await s.getSetting("backup_folder")).toBeUndefined();
    await s.setSetting("backup_folder", "/x", T(0));
    await s.setSetting("backup_folder", "/y", T(1));
    expect(await s.getSetting("backup_folder")).toBe("/y");
    const id = await s.getOrCreateMacId(() => "mac-1");
    expect(id).toBe("mac-1");
    expect(await s.getOrCreateMacId(() => "mac-2")).toBe("mac-1");
    expect(await s.getSetting("mac_id")).toBe("mac-1");
  });
});

describe("FakeBackupStore", () => {
  const run = (id: string, status: NewBackupRun["status"], n: number): NewBackupRun => ({
    id,
    startedAt: T(n),
    finishedAt: T(n + 1),
    trigger: "auto",
    status,
    errorCode: status === "failed" ? "WRITE_FAILED" : null,
    fileName: null,
    sizeBytes: null,
    contentSha256: null,
    summary: null,
  });

  it("空なら undefined", async () => {
    const s = new FakeBackupStore();
    expect(await s.getLastRun()).toBeUndefined();
    expect(await s.getLastCheck()).toBeUndefined();
    expect(await s.getLastSuccess()).toBeUndefined();
    expect(await s.listRuns(5)).toEqual([]);
  });

  it("最後の実行・確認（succeeded か skipped）・成功を返す", async () => {
    const s = new FakeBackupStore();
    await s.recordRun(run("r1", "succeeded", 0));
    await s.recordRun(run("r2", "skipped", 10));
    await s.recordRun(run("r3", "failed", 20));
    expect((await s.getLastRun())?.id).toBe("r3");
    expect((await s.getLastCheck())?.id).toBe("r2");
    expect((await s.getLastSuccess())?.id).toBe("r1");
    expect((await s.listRuns(2)).map((r) => r.id)).toEqual(["r3", "r2"]);
  });
});
