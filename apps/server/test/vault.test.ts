import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearDataKey,
  DrizzleAuthStore,
  isUnlocked,
  openAuth,
  openRegistry,
  registryFile,
  withDataKey,
} from "@trebuchet/db";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepSessions } from "../src/lib/session-sweeper.ts";
import { createVault, setAsideDataFiles } from "../src/lib/vault.ts";
import { makeClock } from "./helpers.ts";

// 008 の D3・D7: メモリー上の DK（db の setDataKey・clearDataKey）と、施錠・解錠の知らせ

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => tmp.cleanup());

const store = () => new DrizzleAuthStore(openAuth(), openRegistry);
const dk = (b: number) => Buffer.alloc(32, b);
const sameAs = (key: Uint8Array) => withDataKey((cur) => Buffer.from(cur).equals(key));

async function addSession(kind: "normal" | "recovery" = "normal", now = new Date().toISOString()) {
  const id = randomUUIDv7();
  await store().createSession({
    id,
    tokenHash: `h-${id}`,
    kind,
    rpId: "localhost",
    passkeyId: null,
    userAgent: null,
    now,
  });
  return id;
}

const sessionCount = () =>
  (openAuth().$client.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;

describe("createVault", () => {
  it("施錠中の unlock: 写しを持って解錠し、registry を開けることを確かめ、解錠を知らせる。渡したバッファは書き換えない", async () => {
    clearDataKey();
    const vault = createVault({ store });
    const seen: boolean[] = [];
    vault.subscribe((u) => seen.push(u));
    const key = dk(3);
    vault.unlock(key);
    expect(vault.isUnlocked()).toBe(true);
    expect(sameAs(dk(3))).toBe(true);
    expect(key.equals(dk(3))).toBe(true);
    expect(existsSync(registryFile())).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("解錠中に同じ DK の unlock は何もしない（知らせない）", () => {
    const vault = createVault({ store });
    const listener = vi.fn();
    vault.subscribe(listener);
    vault.unlock(Buffer.from(TEST_DATA_KEY));
    expect(listener).not.toHaveBeenCalled();
    expect(sameAs(Buffer.from(TEST_DATA_KEY))).toBe(true);
  });

  it("解錠中に別の DK の unlock は例外で、今の DK を保つ", () => {
    const vault = createVault({ store });
    expect(() => vault.unlock(dk(4))).toThrow();
    expect(vault.isUnlocked()).toBe(true);
    expect(sameAs(Buffer.from(TEST_DATA_KEY))).toBe(true);
  });

  it("registry と合わない DK の unlock は例外で、施錠のまま（空の DB を作らない）", () => {
    openRegistry();
    clearDataKey();
    const vault = createVault({ store });
    const listener = vi.fn();
    vault.subscribe(listener);
    expect(() => vault.unlock(dk(5))).toThrow();
    expect(vault.isUnlocked()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    vault.unlock(Buffer.from(TEST_DATA_KEY));
    expect(vault.isUnlocked()).toBe(true);
  });

  it("lock: DK を消し、セッションを全部消し、施錠を知らせる。施錠中の lock はセッションだけ消して知らせない", async () => {
    const vault = createVault({ store });
    const seen: boolean[] = [];
    const unsubscribe = vault.subscribe((u) => seen.push(u));
    await addSession();
    await addSession("recovery");
    await vault.lock();
    expect(isUnlocked()).toBe(false);
    expect(sessionCount()).toBe(0);
    expect(seen).toEqual([false]);
    await addSession();
    await vault.lock();
    expect(sessionCount()).toBe(0);
    expect(seen).toEqual([false]);
    unsubscribe();
    vault.unlock(Buffer.from(TEST_DATA_KEY));
    expect(seen).toEqual([false]);
  });

  it("知らせの関数の例外は外に出さず、ほかの知らせは届く", async () => {
    const vault = createVault({ store });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    vault.subscribe(() => {
      throw new Error("x");
    });
    vault.subscribe(second);
    await vault.lock();
    expect(second).toHaveBeenCalledWith(false);
    log.mockRestore();
  });

  it("withDataKey は施錠中に VaultLockedError", async () => {
    const vault = createVault({ store });
    expect(vault.withDataKey((k) => k.length)).toBe(32);
    await vault.lock();
    expect(() => vault.withDataKey((k) => k.length)).toThrow();
  });
});

describe("setAsideDataFiles（初回の設定で、前の DK の registry・事業体を空から作り直す）", () => {
  it("registry（-wal・-shm を含む）と tenants/ を discarded-<時刻>/ に移す。消さない", () => {
    openRegistry();
    clearDataKey();
    mkdirSync(join(tmp.dir, "tenants"), { recursive: true });
    writeFileSync(join(tmp.dir, "tenants", "x.sqlite"), "x");
    writeFileSync(join(tmp.dir, "auth.keep"), "x");
    const moved = setAsideDataFiles("2026-10-30T01:02:03.004Z");
    expect(moved).toBe(join(tmp.dir, "discarded-20261030T010203004Z"));
    expect(existsSync(registryFile())).toBe(false);
    expect(existsSync(join(tmp.dir, "tenants"))).toBe(false);
    expect(readdirSync(moved ?? "").sort()).toContain("registry.sqlite");
    expect(existsSync(join(moved ?? "", "tenants", "x.sqlite"))).toBe(true);
    expect(existsSync(join(tmp.dir, "auth.keep"))).toBe(true);
  });

  it("移すものがなければ何もしない（null）", () => {
    expect(setAsideDataFiles("2026-10-30T01:02:03.004Z")).toBeNull();
    expect(readdirSync(tmp.dir).filter((n) => n.startsWith("discarded-"))).toEqual([]);
  });
});

describe("sweepSessions（最後のセッションが消えたら施錠する）", () => {
  const clock = makeClock("2026-10-20T09:00:00.000Z");

  it("有効な全権のセッションがあれば施錠しない", async () => {
    const vault = createVault({ store });
    await addSession("normal", clock.now());
    expect(await sweepSessions({ store: store(), vault, now: clock.now() })).toBe(false);
    expect(vault.isUnlocked()).toBe(true);
  });

  it("回復のセッション（10 分）だけでも施錠しない。切れたら施錠してセッションを消す", async () => {
    const vault = createVault({ store });
    await addSession("recovery", clock.now());
    expect(await sweepSessions({ store: store(), vault, now: clock.now() })).toBe(false);
    const later = new Date(Date.parse(clock.now()) + 10 * 60 * 1000).toISOString();
    expect(await sweepSessions({ store: store(), vault, now: later })).toBe(true);
    expect(vault.isUnlocked()).toBe(false);
    expect(sessionCount()).toBe(0);
  });

  it("全権のセッションが無操作 30 分で切れたら施錠する", async () => {
    const vault = createVault({ store });
    await addSession("normal", clock.now());
    const almost = new Date(Date.parse(clock.now()) + 30 * 60 * 1000 - 1).toISOString();
    expect(await sweepSessions({ store: store(), vault, now: almost })).toBe(false);
    const after = new Date(Date.parse(clock.now()) + 30 * 60 * 1000).toISOString();
    expect(await sweepSessions({ store: store(), vault, now: after })).toBe(true);
    expect(vault.isUnlocked()).toBe(false);
  });

  it("施錠中は何もしない", async () => {
    const vault = createVault({ store });
    clearDataKey();
    expect(await sweepSessions({ store: store(), vault, now: clock.now() })).toBe(false);
  });
});
