import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DrizzleAuthStore,
  DrizzleBackupStore,
  dataDir,
  generateRecoveryKey,
  openAuth,
  openRegistry,
  wrapDataKey,
} from "@trebuchet/db";
import { TEST_DATA_KEY, type TempDataDir } from "@trebuchet/db/testing";
import type { WrappedKey } from "@trebuchet/domain";
import { type BackupRunner, createBackupRunner } from "../src/lib/backup-run.ts";
import { makeClock } from "./helpers.ts";

/** `makeClock`（helpers.ts）を、バックアップのテストが使う `{ clock, advance, set }` の形にしたもの */
function mutableClock() {
  const clock = makeClock();
  return { clock, advance: clock.advance, set: clock.set };
}

export const HOUR = 60 * 60 * 1000;

export type BackupEnv = {
  folder: string;
  tmpRoot: string;
  runner: BackupRunner;
  clock: ReturnType<typeof mutableClock>;
  auth: () => DrizzleAuthStore;
  backups: () => DrizzleBackupStore;
  /** 初回の設定で作った回復キー（本文）と recovery の包み（`auth.sqlite` に入れてある。DK はテスト用の固定の DK） */
  recovery: { text: string; wrap: WrappedKey };
  files(): string[];
  snapshotLeftovers(): string[];
  /**
   * 片付け。実行中のバックアップが終わるのを待ってから、一時のデータ場所を消す。
   * 終わりを待たない実行（`start` の戻りの `done` を見ないもの）が、片付けの後に作業場所
   * （`<tmp.dir>/snap`）を作り直して `.tmp/` に残すのを防ぐ。afterEach で必ずこれを呼ぶ
   */
  finish(): Promise<void>;
};

/** 回復キーを作り、DK（テスト用の固定の DK）を包んだ recovery の包みを `auth.sqlite` に入れる */
function seedRecoveryWrap(now: string): BackupEnv["recovery"] {
  const key = generateRecoveryKey();
  const wrap = wrapDataKey(TEST_DATA_KEY, key.secret, "recovery", null);
  openAuth()
    .$client.prepare(
      "INSERT INTO key_wraps (id, kind, credential_id, salt, iv, tag, wrapped, created_at) VALUES (?, 'recovery', NULL, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUIDv7(),
      Buffer.from(wrap.salt),
      Buffer.from(wrap.iv),
      Buffer.from(wrap.tag),
      Buffer.from(wrap.wrapped),
      now,
    );
  return { text: key.text, wrap };
}

/** useTempDataDir の後に呼ぶ。置き場所・平文の写しの作業場所は `.tmp/` の下。recovery の包みも入れる */
export function makeBackupEnv(
  tmp: TempDataDir,
  opts: {
    dataDirOverride?: string;
    /** 同じデータ場所に 2 つめの env を作るとき、先の env の recovery を渡す（包みを重ねて入れない） */
    recovery?: BackupEnv["recovery"];
  } = {},
): BackupEnv {
  const folder = join(tmp.dir, "dest");
  const tmpRoot = join(tmp.dir, "snap");
  mkdirSync(folder, { recursive: true });
  const clock = mutableClock();
  const auth = () => new DrizzleAuthStore(openAuth(), openRegistry);
  const backups = () => new DrizzleBackupStore(openRegistry());
  const runner = createBackupRunner({
    auth,
    backups,
    clock: clock.clock,
    ids: { next: () => randomUUIDv7() },
    dataDir: () => opts.dataDirOverride ?? dataDir(),
    tmpRoot,
  });
  const recovery = opts.recovery ?? seedRecoveryWrap(clock.clock.now());
  return {
    folder,
    tmpRoot,
    runner,
    clock,
    auth,
    backups,
    recovery,
    files: () => readdirSync(folder).sort(),
    snapshotLeftovers: () => {
      try {
        return readdirSync(tmpRoot).filter((n) => n.startsWith("backup-snapshot-"));
      } catch {
        return [];
      }
    },
    finish: async () => {
      await runner.idle();
      tmp.cleanup();
    },
  };
}

/** 置き場所を設定済みにする（app_settings） */
export async function configure(env: BackupEnv): Promise<void> {
  const now = env.clock.clock.now();
  await env.auth().setSetting("backup_folder", env.folder, now);
}
