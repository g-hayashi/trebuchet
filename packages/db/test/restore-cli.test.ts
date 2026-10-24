import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isServerRunning,
  type RestoreCliDeps,
  runRestoreCli,
} from "../../../scripts/lib/restore-cli.ts";
import { packArchive } from "../src/backup/archive.ts";
import { encryptBackup } from "../src/backup/crypto.ts";
import { createSnapshotDir, currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { seedEntities } from "./backup-fixtures.ts";

const PASS = "terminal passphrase 日本語";
const ENV_PASS = "passphrase-from-env";

let tmp: TempDataDir;
let server: Server | undefined;
beforeEach(() => {
  tmp = useTempDataDir("restore-cli");
});
afterEach(async () => {
  tmp.cleanup();
  const s = server;
  server = undefined;
  if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
});

const dataDir = () => join(tmp.dir, "dest", "data");
const backupFile = () => join(tmp.dir, "backup.tbk");

/** 実際の鍵導出（Argon2id）で .tbk を作る。src は tmp.dir/src */
async function makeBackup(appVersion = currentAppVersion()): Promise<void> {
  const src = join(tmp.dir, "src");
  mkdirSync(src, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = src;
  closeAll();
  openRegistry();
  seedEntities([{ name: "事業", kind: "individual", seed: 1, journals: 3, memo: "", note: "" }]);
  closeAll();
  process.env.TREBUCHET_DATA_DIR = tmp.dir;
  const snapDir = createSnapshotDir(join(tmp.dir, "scratch"));
  try {
    const bytes = await encryptBackup(packArchive(snapshotDataDir(src, snapDir)), PASS, {
      appVersion,
      macId: "mac-src",
      createdAt: "2026-10-31T09:00:00.000Z",
    });
    writeFileSync(backupFile(), bytes);
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
}

type Harness = {
  deps: RestoreCliDeps;
  out: string[];
  err: string[];
  calls: { passphrase: number; confirm: number; server: number };
};

function harness(overrides: Partial<RestoreCliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls = { passphrase: 0, confirm: 0, server: 0 };
  const deps: RestoreCliDeps = {
    env: { TREBUCHET_PASSPHRASE: ENV_PASS, PASSPHRASE: ENV_PASS },
    defaultDataDir: join(tmp.dir, "must-not-be-used"),
    tmpRoot: join(tmp.dir, "scratch"),
    readPassphrase: async () => {
      calls.passphrase += 1;
      return PASS;
    },
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    isServerRunning: async () => {
      calls.server += 1;
      return false;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
  return { deps, out, err, calls };
}

const args = (...extra: string[]) => ["--file", backupFile(), "--data-dir", dataDir(), ...extra];
const siblings = () => {
  try {
    return readdirSync(join(tmp.dir, "dest"));
  } catch {
    return [];
  }
};

describe("restore-backup（使い方と終了コード）", () => {
  it("--file がないと 2（パスフレーズも server も確かめない）", async () => {
    const h = harness();
    expect(await runRestoreCli(["--data-dir", dataDir()], h.deps)).toBe(2);
    expect(h.calls).toEqual({ passphrase: 0, confirm: 0, server: 0 });
    expect(h.err.join("\n")).toContain("--file");
  });

  it("未知の引数（--passphrase を含む）は 2 で、パスフレーズを使わない", async () => {
    const h = harness();
    expect(await runRestoreCli(args("--passphrase", ENV_PASS), h.deps)).toBe(2);
    expect(h.calls.passphrase).toBe(0);
    expect(h.out.join("\n") + h.err.join("\n")).not.toContain(ENV_PASS);
  });

  it("pnpm が渡す先頭の `--` を無視する", async () => {
    const h = harness({ isServerRunning: async () => true });
    expect(await runRestoreCli(["--", ...args()], h.deps)).toBe(3);
  });

  it("server が動いていると 3（パスフレーズを尋ねず、何も作らない）", async () => {
    const h = harness({ isServerRunning: async () => true });
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(3);
    expect(h.calls.passphrase).toBe(0);
    expect(siblings()).toEqual([]);
  });

  it("実際に待ち受けているポートに接続できれば、動いているとみなす（別のポートで検査）", async (ctx) => {
    const s = createServer();
    server = s;
    const port = await new Promise<number | undefined>((resolve, reject) => {
      s.once("error", (e: NodeJS.ErrnoException) => {
        // ポートを開けない環境（サンドボックスなど）では、この確かめだけを飛ばす
        if (e.code === "EPERM" || e.code === "EACCES") resolve(undefined);
        else reject(e);
      });
      s.listen(0, "127.0.0.1", () => {
        const address = s.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    if (port === undefined) {
      server = undefined;
      ctx.skip("127.0.0.1 のポートを開けない環境");
      return;
    }
    expect(await isServerRunning(port)).toBe(true);
    await new Promise<void>((resolve) => s.close(() => resolve()));
    server = undefined;
    expect(await isServerRunning(port)).toBe(false);
  });

  it("確認で拒否すると 4（何も作らない）", async () => {
    await makeBackup();
    let asked = 0;
    const h = harness({
      confirm: async () => {
        asked += 1;
        return false;
      },
    });
    expect(await runRestoreCli(args(), h.deps)).toBe(4);
    expect(asked).toBe(1);
    expect(siblings()).toEqual([]);
  });

  it("成功は 0。要約を表示し、--yes なら確認しない。パスフレーズは端末の入力だけを使い、出力に出さない", async () => {
    await makeBackup();
    const h = harness();
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(0);
    expect(h.calls).toEqual({ passphrase: 1, confirm: 0, server: 1 });
    const text = h.out.join("\n");
    expect(text).toContain("作成日時");
    expect(text).toContain("2026-10-31T09:00:00.000Z");
    expect(text).toContain("mac-src");
    expect(text).toContain("事業");
    expect(text).toContain("復元しました。アプリを起動し、パスキーを登録してください");
    expect(text + h.err.join("\n")).not.toContain(PASS);
    expect(text + h.err.join("\n")).not.toContain(ENV_PASS);
    expect(siblings()).toEqual(["data"]);
  });

  it("--data-dir がなければ TREBUCHET_DATA_DIR、それもなければ defaultDataDir", async () => {
    await makeBackup();
    const viaEnv = harness({
      env: { TREBUCHET_DATA_DIR: dataDir() },
      defaultDataDir: join(tmp.dir, "must-not-be-used"),
    });
    expect(await runRestoreCli(["--file", backupFile(), "--yes"], viaEnv.deps)).toBe(0);
    expect(siblings()).toEqual(["data"]);

    rmSync(join(tmp.dir, "dest"), { recursive: true, force: true });
    const viaDefault = harness({ env: {}, defaultDataDir: dataDir() });
    expect(await runRestoreCli(["--file", backupFile(), "--yes"], viaDefault.deps)).toBe(0);
    expect(siblings()).toEqual(["data"]);
  });

  it("誤ったパスフレーズは 1 で、決められた文言を出し、何も作らない", async () => {
    await makeBackup();
    const h = harness({ readPassphrase: async () => "wrong passphrase" });
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("パスフレーズが違うか、ファイルが壊れています");
    expect(h.err.join("\n")).not.toContain("wrong passphrase");
    expect(siblings()).toEqual([]);
  });

  it("版の違うバックアップは 1 で、決められた文言を出し、何も作らない", async () => {
    const v = currentAppVersion();
    await makeBackup({ registry: v.registry + 1, tenant: v.tenant });
    const h = harness();
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain(
      "アプリの版が一致しません。このバックアップを取った版のアプリで復元してください",
    );
    expect(siblings()).toEqual([]);
  });

  it("存在しない --file は 2", async () => {
    const h = harness();
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(2);
    expect(h.calls.passphrase).toBe(0);
  });
});
