import { createHash, randomUUIDv7 } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CryptoOptions,
  DrizzleAuthStore,
  DrizzleBackupStore,
  dataDir,
  openRegistry,
} from "@trebuchet/db";
import type { TempDataDir } from "@trebuchet/db/testing";
import { type BackupRunner, createBackupRunner } from "../src/lib/backup-run.ts";
import { BACKUP_PASSPHRASE_KEY, createMemorySecretStore } from "../src/lib/keychain.ts";
import { makeClock } from "./helpers.ts";

/** 鍵導出を軽くする（本物の Argon2id は 64 MiB × 3 回で遅い）。`breakAfter` 回目以降は別の鍵を返す */
export function fastCrypto(state: { calls: number; breakAfter?: number } = { calls: 0 }): {
  crypto: CryptoOptions;
  state: { calls: number; breakAfter?: number };
} {
  return {
    state,
    crypto: {
      deriveKey: async (passphrase, kdf) => {
        state.calls += 1;
        const tag = state.breakAfter !== undefined && state.calls > state.breakAfter ? "x" : "";
        return createHash("sha256").update(tag).update(passphrase).update(kdf.salt).digest();
      },
    },
  };
}

/** `makeClock`（helpers.ts）を、バックアップのテストが使う `{ clock, advance, set }` の形にしたもの */
function mutableClock() {
  const clock = makeClock();
  return { clock, advance: clock.advance, set: clock.set };
}

export const HOUR = 60 * 60 * 1000;
export const PASSPHRASE = "correct horse battery staple";

export type BackupEnv = {
  folder: string;
  tmpRoot: string;
  runner: BackupRunner;
  secrets: ReturnType<typeof createMemorySecretStore>;
  clock: ReturnType<typeof mutableClock>;
  auth: () => DrizzleAuthStore;
  backups: () => DrizzleBackupStore;
  crypto: ReturnType<typeof fastCrypto>;
  files(): string[];
  snapshotLeftovers(): string[];
};

/** useTempDataDir の後に呼ぶ。置き場所・平文の写しの作業場所は `.tmp/` の下 */
export function makeBackupEnv(
  tmp: TempDataDir,
  opts: { configured?: boolean; passphrase?: string | null; dataDirOverride?: string } = {},
): BackupEnv {
  const folder = join(tmp.dir, "dest");
  const tmpRoot = join(tmp.dir, "snap");
  mkdirSync(folder, { recursive: true });
  const clock = mutableClock();
  const secrets = createMemorySecretStore();
  const crypto = fastCrypto();
  const auth = () => new DrizzleAuthStore(openRegistry());
  const backups = () => new DrizzleBackupStore(openRegistry());
  const runner = createBackupRunner({
    auth,
    backups,
    secrets,
    clock: clock.clock,
    ids: { next: () => randomUUIDv7() },
    dataDir: () => opts.dataDirOverride ?? dataDir(),
    tmpRoot,
    crypto: crypto.crypto,
  });
  const env: BackupEnv = {
    folder,
    tmpRoot,
    runner,
    secrets,
    clock,
    auth,
    backups,
    crypto,
    files: () => readdirSync(folder).sort(),
    snapshotLeftovers: () => {
      try {
        return readdirSync(tmpRoot).filter((n) => n.startsWith("backup-snapshot-"));
      } catch {
        return [];
      }
    },
  };
  if (opts.passphrase !== null) {
    void secrets.set(BACKUP_PASSPHRASE_KEY, opts.passphrase ?? PASSPHRASE);
  }
  return env;
}

/** 置き場所を設定済みにする（app_settings） */
export async function configure(env: BackupEnv): Promise<void> {
  const now = env.clock.clock.now();
  await env.auth().setSetting("backup_folder", env.folder, now);
  await env.auth().setSetting("backup_passphrase_set", "1", now);
}
