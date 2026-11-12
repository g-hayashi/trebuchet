import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearDataKey,
  DrizzleAuthStore,
  openAuth,
  openRegistry,
  registryFile,
} from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorOf } from "./helpers.ts";
import { setupPairing } from "./pairing-helpers.ts";
import { regResponse } from "./webauthn-fakes.ts";

// 初回の設定（completeSetup）が、元データを discarded-* へ移した後に失敗したら、元の場所へ戻す

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server");
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

/** initializeVault だけが失敗する認証ストア（`onInitialize` は失敗の直前に呼ぶ） */
function failingStore(onInitialize: () => void = () => {}) {
  const real = new DrizzleAuthStore(openAuth(), openRegistry);
  const faulty = Object.create(real) as DrizzleAuthStore;
  faulty.initializeVault = async () => {
    onInitialize();
    throw new Error("disk full: secret-detail");
  };
  return () => faulty;
}

/** 前の DK の registry と事業体の DB に見立てたファイルを置く（施錠した状態で） */
function seedOldData() {
  openRegistry();
  clearDataKey();
  mkdirSync(join(tmp.dir, "tenants"), { recursive: true });
  writeFileSync(join(tmp.dir, "tenants", "x.sqlite"), "old-tenant");
}

const discardedDirs = () => readdirSync(tmp.dir).filter((n) => n.startsWith("discarded-"));

async function register(t: ReturnType<typeof setupPairing>) {
  const opts = await (await t.call("POST", "/auth/register/options")).json();
  return t.call("POST", "/auth/register/verify", { body: { response: regResponse(opts, "p1") } });
}

describe("初回の設定の失敗時（initializeVault の失敗）", () => {
  it("移した registry・tenants を元の場所へ戻し、500 INTERNAL を返す（設定済みにならない）", async () => {
    seedOldData();
    const t = setupPairing({ store: failingStore() });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await register(t);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("INTERNAL");
    expect(existsSync(registryFile())).toBe(true);
    expect(existsSync(join(tmp.dir, "tenants", "x.sqlite"))).toBe(true);
    expect(discardedDirs()).toEqual([]);
    log.mockRestore();
  });

  it("戻すのにも失敗したら、その旨をログに出し（鍵・秘密は出さない）、元のエラーを返す", async () => {
    seedOldData();
    // 失敗の直前に、元の場所に別のファイルができた状態を作る（戻せない）
    const t = setupPairing({
      store: failingStore(() => {
        mkdirSync(join(tmp.dir, "tenants"), { recursive: true });
        writeFileSync(join(tmp.dir, "tenants", "new.sqlite"), "new");
      }),
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await register(t);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe("INTERNAL");
    const logged = JSON.stringify(log.mock.calls.map((c) => c.map(String)));
    expect(logged).toContain("初回の設定");
    expect(logged).toContain("戻せません");
    // 移した先は残る（手で戻せる）
    expect(discardedDirs()).toHaveLength(1);
  });
});
