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
  createdAt: T(0),
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
    await s.addPasskey(newPasskey("a"));
    await s.addPasskey(newPasskey("b", "x.ts.net"));
    expect((await s.listPasskeys()).map((p) => p.id)).toEqual(["a", "b"]);
    expect((await s.getPasskey("a"))?.lastUsedAt).toBeNull();
    await s.renamePasskey("a", "新しい名前");
    await s.recordPasskeyUse("a", 7, T(5));
    const a = await s.getPasskey("a");
    expect(a).toMatchObject({ name: "新しい名前", counter: 7, lastUsedAt: T(5) });
    await s.deletePasskey("a");
    expect(await s.getPasskey("a")).toBeUndefined();
  });

  it("回復コード: 置き換えると有効な行は 1 つだけ", async () => {
    const s = new FakeAuthStore();
    expect(await s.getActiveRecoveryCode()).toBeUndefined();
    await s.replaceRecoveryCode("hash1", T(0), "revoked");
    const first = await s.getActiveRecoveryCode();
    expect(first?.codeHash).toBe("hash1");
    await s.replaceRecoveryCode("hash2", T(1), "used");
    const second = await s.getActiveRecoveryCode();
    expect(second?.codeHash).toBe("hash2");
    expect(second?.id).not.toBe(first?.id);
    expect(s.recoveryCodes.filter((r) => !r.usedAt && !r.revokedAt)).toHaveLength(1);
    expect(s.recoveryCodes.find((r) => r.codeHash === "hash1")?.usedAt).toBe(T(1));
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
