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
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { recoveryFixture, seedEntities } from "./backup-fixtures.ts";

/** 端末から入力する回復キー（バックアップの recovery の包みを開く。DK はテスト用の固定の DK） */
const recovery = recoveryFixture(TEST_DATA_KEY);
const ENV_KEY = "KEY-FROM-ENV";

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

/** DK と recovery の包みで .tbk を作る。src は tmp.dir/src */
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
    const bytes = encryptBackup(packArchive(snapshotDataDir(src, snapDir)), TEST_DATA_KEY, {
      appVersion,
      macId: "mac-src",
      createdAt: "2026-10-31T09:00:00.000Z",
      recoveryWrap: recovery.wrap,
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
  calls: { recoveryKey: number; confirm: number; server: number };
};

function harness(overrides: Partial<RestoreCliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls = { recoveryKey: 0, confirm: 0, server: 0 };
  const deps: RestoreCliDeps = {
    env: { TREBUCHET_RECOVERY_KEY: ENV_KEY, RECOVERY_KEY: ENV_KEY },
    defaultDataDir: join(tmp.dir, "must-not-be-used"),
    tmpRoot: join(tmp.dir, "scratch"),
    readRecoveryKey: async () => {
      calls.recoveryKey += 1;
      return recovery.text;
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
  it("--file がないと 2（回復キーも server も確かめない）", async () => {
    const h = harness();
    expect(await runRestoreCli(["--data-dir", dataDir()], h.deps)).toBe(2);
    expect(h.calls).toEqual({ recoveryKey: 0, confirm: 0, server: 0 });
    expect(h.err.join("\n")).toContain("--file");
  });

  it("未知の引数（--recovery-key・--passphrase を含む）は 2 で、回復キーを引数では受け取らない", async () => {
    for (const flag of ["--recovery-key", "--passphrase"]) {
      const h = harness();
      expect(await runRestoreCli(args(flag, recovery.text), h.deps)).toBe(2);
      expect(h.calls.recoveryKey).toBe(0);
      expect(h.out.join("\n") + h.err.join("\n")).not.toContain(recovery.text);
    }
  });

  it("pnpm が渡す先頭の `--` を無視する", async () => {
    const h = harness({ isServerRunning: async () => true });
    expect(await runRestoreCli(["--", ...args()], h.deps)).toBe(3);
  });

  it("server が動いていると 3（回復キーを尋ねず、何も作らない）", async () => {
    const h = harness({ isServerRunning: async () => true });
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(3);
    expect(h.calls.recoveryKey).toBe(0);
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

  it("成功は 0。要約を表示し、--yes なら確認しない。回復キーは端末の入力だけを使い、出力に出さない", async () => {
    await makeBackup();
    const h = harness();
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(0);
    expect(h.calls).toEqual({ recoveryKey: 1, confirm: 0, server: 1 });
    const text = h.out.join("\n");
    expect(text).toContain("作成日時");
    expect(text).toContain("2026-10-31T09:00:00.000Z");
    expect(text).toContain("mac-src");
    expect(text).toContain("事業");
    expect(text).toContain(
      "復元しました。アプリを起動し、回復キーで解錠して、新しいパスキーを登録してください",
    );
    expect(text + h.err.join("\n")).not.toContain(recovery.text);
    expect(text + h.err.join("\n")).not.toContain(ENV_KEY);
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

  it("誤った回復キーは 1 で、決められた文言を出し、何も作らない", async () => {
    await makeBackup();
    const wrong = recoveryFixture(TEST_DATA_KEY).text;
    const h = harness({ readRecoveryKey: async () => wrong });
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("回復キーが違うか、ファイルが壊れています");
    expect(h.err.join("\n")).not.toContain(wrong);
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

  describe("証憑（010 T025）", () => {
    type RestoreFn = NonNullable<RestoreCliDeps["restore"]>;
    // 偽の復元は中身を読まない。ファイルがあることだけを CLI が確かめる
    beforeEach(() => writeFileSync(backupFile(), "not-a-real-backup"));
    /** 渡された options を控え、決めた結果を返す偽の復元 */
    function fakeRestore(
      outcome: "ok" | "missing",
      count = 0,
    ): { restore: RestoreFn; seen: Parameters<RestoreFn>[0][] } {
      const seen: Parameters<RestoreFn>[0][] = [];
      const restore: RestoreFn = async (options) => {
        seen.push(options);
        if (outcome === "missing") {
          options.onReceiptsMissing?.(count);
          return { ok: false, error: "RECEIPTS_MISSING" };
        }
        return {
          ok: true,
          value: {
            summary: {
              createdAt: "x",
              macId: "m",
              appVersion: { registry: 1, tenant: 1 },
              entities: [],
              hasExistingLedger: false,
              differences: [],
            },
            beforeRestoreBackup: null,
            previousDataDir: null,
            missingReceipts: count,
          },
        };
      };
      return { restore, seen };
    }

    it("--receipts-dir の既定は .tbk と同じフォルダの trebuchet-receipts/。フラグがなければ欠けを許さない", async () => {
      const f = fakeRestore("ok");
      const h = harness({ restore: f.restore });
      expect(await runRestoreCli(args("--yes"), h.deps)).toBe(0);
      expect(f.seen[0]?.receiptsDir).toBe(join(tmp.dir, "trebuchet-receipts"));
      expect(f.seen[0]?.allowMissingReceipts).toBe(false);
    });

    it("--receipts-dir と --allow-missing-receipts を復元に渡す", async () => {
      const f = fakeRestore("ok");
      const h = harness({ restore: f.restore });
      const code = await runRestoreCli(
        args("--yes", "--receipts-dir", join(tmp.dir, "elsewhere"), "--allow-missing-receipts"),
        h.deps,
      );
      expect(code).toBe(0);
      expect(f.seen[0]?.receiptsDir).toBe(join(tmp.dir, "elsewhere"));
      expect(f.seen[0]?.allowMissingReceipts).toBe(true);
    });

    it("RECEIPTS_MISSING は 1 で、件数と対処（--allow-missing-receipts）を出し、帳簿は変わらないと伝える", async () => {
      const f = fakeRestore("missing", 3);
      const h = harness({ restore: f.restore });
      expect(await runRestoreCli(args("--yes"), h.deps)).toBe(1);
      const text = h.err.join("\n");
      expect(text).toContain("3 件");
      expect(text).toContain("--allow-missing-receipts");
      expect(text).toContain("帳簿は変わっていません");
    });

    it("欠けを許して成功したときは、戻せなかった件数を知らせる", async () => {
      const f = fakeRestore("ok", 2);
      const h = harness({ restore: f.restore });
      expect(await runRestoreCli(args("--yes", "--allow-missing-receipts"), h.deps)).toBe(0);
      expect(h.out.join("\n")).toContain("2 件");
    });
  });

  it("存在しない --file は 2", async () => {
    const h = harness();
    expect(await runRestoreCli(args("--yes"), h.deps)).toBe(2);
    expect(h.calls.recoveryKey).toBe(0);
  });
});
