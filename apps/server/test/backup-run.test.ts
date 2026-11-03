import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  backupFileName,
  clearDataKey,
  currentAppVersion,
  decryptBackup,
  decryptBackupWithRecoveryKey,
  generateRecoveryKey,
  RECEIPT_STORE_DIRNAME,
  receiptBackupName,
  receiptFile,
  receiptRefsFromSnapshotFiles,
  unpackArchive,
  wrapDataKey,
} from "@trebuchet/db";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addReceiptFile, type BackupEnv, configure, makeBackupEnv } from "./backup-helpers.ts";
import { createTestEntity } from "./helpers.ts";

// バックアップの実行（スナップショット → 内容の SHA-256 → skip の判断 → 暗号化（DK から作った鍵） → 書き込み → 世代の整理 → 記録）

/** VERIFY_FAILED の試験用: 立てている間は、暗号化したファイルの最後の 1 バイト（認証タグ）を壊す */
const hooks = vi.hoisted(() => ({ corrupt: false }));
vi.mock("@trebuchet/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trebuchet/db")>();
  return {
    ...actual,
    encryptBackup: (...args: Parameters<typeof actual.encryptBackup>) => {
      const bytes = actual.encryptBackup(...args);
      if (hooks.corrupt) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      return bytes;
    },
  };
});

let tmp: TempDataDir;
let env: BackupEnv;
beforeEach(async () => {
  hooks.corrupt = false;
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  env = makeBackupEnv(tmp);
  await configure(env);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.finish();
});

const DAY = 24 * 60 * 60 * 1000;

/**
 * 実行して終わりを待つ。1 つ前の実行と同じ秒のファイル名にならないよう、先に時計を進める。
 * 世代の整理は「日ごとに最新の 1 つ」なので、ファイルを積み上げて数えたいときは `gap` に 1 日以上を渡す
 */
async function runOnce(trigger: "manual" | "auto", gap = 1000) {
  env.clock.advance(gap);
  const started = await env.runner.start(trigger);
  if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
  return started.value.done;
}

describe("成功", () => {
  it("ファイルができ、backup_runs に succeeded（ファイル名・大きさ・SHA-256・要約）が残る", async () => {
    const run = await runOnce("manual");
    expect(run.status).toBe("succeeded");
    expect(run.errorCode).toBeNull();
    expect(run.trigger).toBe("manual");
    expect(env.files()).toEqual([run.fileName]);
    expect(run.fileName).toMatch(/^trebuchet-[0-9a-f]{8}-20261020-090001\.tbk$/);
    expect(run.sizeBytes).toBe(readFileSync(join(env.folder, run.fileName ?? "")).length);
    expect(run.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.summary?.map((e) => e.name)).toEqual(["事業 A"]);
    expect(await env.backups().getLastRun()).toEqual(run);
    expect(await env.auth().getSetting("backup_force_write")).not.toBe("1");
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("鍵は DK から作る。そのときの回復キー（ヘッダーの包み）でも DK でも開け、本体は事業 A を含む（INV-54）", async () => {
    const run = await runOnce("manual");
    const bytes = readFileSync(join(env.folder, run.fileName ?? ""));
    const byRecovery = decryptBackupWithRecoveryKey(bytes, env.recovery.text, currentAppVersion());
    expect(byRecovery.ok).toBe(true);
    const byDk = decryptBackup(bytes, TEST_DATA_KEY, currentAppVersion());
    expect(byDk.ok).toBe(true);
    if (!byRecovery.ok || !byDk.ok) return;
    expect(byRecovery.value.dk.equals(Buffer.from(TEST_DATA_KEY))).toBe(true);
    const unpacked = unpackArchive(byDk.value.archive);
    expect(unpacked.ok && unpacked.value.manifest.entities.map((e) => e.name)).toEqual(["事業 A"]);
    // 誤った回復キーでは開かない
    expect(
      decryptBackupWithRecoveryKey(bytes, generateRecoveryKey().text, currentAppVersion()),
    ).toEqual({ ok: false, error: "INVALID" });
  });

  it("回復キーの再発行の後の実行は新しい包みを入れ、古いファイルも古いキーのまま開ける", async () => {
    const first = await runOnce("manual");
    const next = generateRecoveryKey();
    await env
      .auth()
      .replaceRecoveryWrap(
        wrapDataKey(TEST_DATA_KEY, next.secret, "recovery", null),
        env.clock.clock.now(),
      );
    const second = await runOnce("manual", DAY);
    const bytes1 = readFileSync(join(env.folder, first.fileName ?? ""));
    const bytes2 = readFileSync(join(env.folder, second.fileName ?? ""));
    const version = currentAppVersion();
    expect(decryptBackupWithRecoveryKey(bytes1, env.recovery.text, version).ok).toBe(true);
    expect(decryptBackupWithRecoveryKey(bytes1, next.text, version).ok).toBe(false);
    expect(decryptBackupWithRecoveryKey(bytes2, next.text, version).ok).toBe(true);
    expect(decryptBackupWithRecoveryKey(bytes2, env.recovery.text, version).ok).toBe(false);
  });

  it("start は終わりを待たずに runId を返す。記録の id は runId と同じ", async () => {
    const started = await env.runner.start("manual");
    if (!started.ok) throw new Error("start failed");
    expect(await env.backups().getLastRun()).toBeUndefined();
    expect(env.runner.isRunning()).toBe(true);
    const run = await started.value.done;
    expect(run.id).toBe(started.value.runId);
    expect(env.runner.isRunning()).toBe(false);
  });

  it("実行中も event loop が回る（長い処理の間に await を挟む）", async () => {
    let ticks = 0;
    let stop = false;
    const spin = () => {
      if (stop) return;
      ticks += 1;
      setImmediate(spin);
    };
    spin();
    await runOnce("manual");
    stop = true;
    expect(ticks).toBeGreaterThanOrEqual(3);
  });
});

describe("変更なし（skipped）", () => {
  it("自動で内容が同じなら skipped。ファイルは増えず、前回の成功の SHA-256 が入り、新しい最後の確認になる", async () => {
    const first = await runOnce("auto");
    expect(first.status).toBe("succeeded");
    const second = await runOnce("auto");
    expect(second.status).toBe("skipped");
    expect(second.fileName).toBeNull();
    expect(second.contentSha256).toBe(first.contentSha256);
    expect(env.files()).toHaveLength(1);
    expect((await env.backups().getLastCheck())?.id).toBe(second.id);
    expect((await env.backups().getLastSuccess())?.id).toBe(first.id);
  });

  it("手動は同じ内容でも succeeded でファイルが増える", async () => {
    await runOnce("auto");
    const manual = await runOnce("manual", DAY);
    expect(manual.status).toBe("succeeded");
    expect(env.files()).toHaveLength(2);
  });

  it("置き場所のファイルを手で消すと、内容が同じでも次の自動が書く", async () => {
    const first = await runOnce("auto");
    rmSync(join(env.folder, first.fileName ?? ""));
    const next = await runOnce("auto");
    expect(next.status).toBe("succeeded");
    expect(env.files()).toHaveLength(1);
  });

  it("backup_force_write（置き場所の設定の直後）が立っていれば自動も書き、成功で消える", async () => {
    await runOnce("auto");
    await env.auth().setSetting("backup_force_write", "1", env.clock.clock.now());
    const forced = await runOnce("auto", DAY);
    expect(forced.status).toBe("succeeded");
    expect(env.files()).toHaveLength(2);
    expect(await env.auth().getSetting("backup_force_write")).toBe("0");
    expect((await runOnce("auto")).status).toBe("skipped");
  });

  it("失敗した実行では backup_force_write を消さない", async () => {
    await env.auth().setSetting("backup_force_write", "1", env.clock.clock.now());
    rmSync(env.folder, { recursive: true, force: true });
    const failed = await runOnce("manual");
    expect(failed.status).toBe("failed");
    expect(await env.auth().getSetting("backup_force_write")).toBe("1");
  });

  it("帳簿を変えると新しいファイルを書く", async () => {
    await runOnce("auto");
    await createTestEntity("事業 B");
    const next = await runOnce("auto", DAY);
    expect(next.status).toBe("succeeded");
    expect(env.files()).toHaveLength(2);
    expect(next.summary?.map((e) => e.name).sort()).toEqual(["事業 A", "事業 B"]);
  });
});

describe("失敗", () => {
  it("置き場所がなければ failed と FOLDER_NOT_FOUND（世代は整理しない）", async () => {
    await runOnce("manual");
    const moved = `${env.folder}-moved`;
    renameSync(env.folder, moved);
    const run = await runOnce("manual");
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("FOLDER_NOT_FOUND");
    expect(run.fileName).toBeNull();
    expect(readdirSync(moved)).toHaveLength(1);
    expect(await env.backups().getLastSuccess()).toBeDefined();
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("読み戻しの検証が失敗すると VERIFY_FAILED。最終の名前のファイルは残らず、世代も整理しない", async () => {
    const macId = await env.auth().getOrCreateMacId(() => "0192f3a0-1111-7000-8000-000000000001");
    const older = backupFileName(macId, new Date("2026-09-01T01:00:00Z"));
    const newer = backupFileName(macId, new Date("2026-09-01T02:00:00Z"));
    writeFileSync(join(env.folder, older), "old");
    writeFileSync(join(env.folder, newer), "new");
    hooks.corrupt = true; // 書いたファイルの認証タグを壊す（読み戻しの復号が通らない）
    const run = await runOnce("manual");
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("VERIFY_FAILED");
    expect(env.files().sort()).toEqual([older, newer].sort());
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("施錠中（DK がない）なら始めず LOCKED を返す。記録も平文の写しも作らない", async () => {
    clearDataKey();
    const started = await env.runner.start("auto");
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.code).toBe("LOCKED");
    expect(env.runner.isRunning()).toBe(false);
    expect(env.files()).toEqual([]);
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("スナップショットの作成が失敗しても failed で記録し、平文の写しを残さない", async () => {
    const empty = join(tmp.dir, "no-data");
    mkdirSync(empty);
    const env2 = makeBackupEnv(tmp, { dataDirOverride: empty, recovery: env.recovery });
    const started = await env2.runner.start("manual");
    if (!started.ok) throw new Error("start failed");
    const run = await started.value.done;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("SNAPSHOT_FAILED");
    expect(env2.snapshotLeftovers()).toEqual([]);
  });
});

describe("証憑の写し（010 T026、INV-68）", () => {
  const storeDir = () => join(env.folder, RECEIPT_STORE_DIRNAME);
  const storeFiles = (entityId: string) => {
    try {
      return readdirSync(join(storeDir(), entityId)).sort();
    } catch {
      return [];
    }
  };
  const storeName = (sha: string) => `${receiptBackupName(Buffer.from(TEST_DATA_KEY), sha)}.trc`;

  /** `.tbk` の写しの DB が参照する証憑 */
  function referencedBy(fileName: string) {
    const bytes = readFileSync(join(env.folder, fileName));
    const dec = decryptBackup(bytes, TEST_DATA_KEY, currentAppVersion());
    if (!dec.ok) throw new Error("decrypt");
    const unpacked = unpackArchive(dec.value.archive);
    if (!unpacked.ok) throw new Error("unpack");
    return receiptRefsFromSnapshotFiles(unpacked.value.files);
  }

  it("`.tbk` が参照する全証憑が、置き場所に名前を変えて写されている（名前は平文のハッシュと違う）", async () => {
    const entityId = await createTestEntity("事業 B");
    const shas = [addReceiptFile(entityId, "a"), addReceiptFile(entityId, "b")];

    const run = await runOnce("manual");

    expect(run.status).toBe("succeeded");
    const refs = referencedBy(run.fileName ?? "");
    const ref = refs.find((r) => r.entityId === entityId);
    expect([...(ref?.sha256s ?? [])].sort()).toEqual([...shas].sort());
    expect(storeFiles(entityId)).toEqual(shas.map(storeName).sort());
    for (const sha of shas) expect(storeFiles(entityId).join()).not.toContain(sha);
    // 置き場所のファイルは `.tbk` のフォルダの直下ではなく trebuchet-receipts/ の下。`.tbk` の一覧に混ざらない
    expect(env.files().filter((n) => n.endsWith(".tbk"))).toEqual([run.fileName]);
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("2 回目は増えた分だけ写す。変更なし（skipped）のときも、置き場所の欠けを写し直す", async () => {
    const entityId = await createTestEntity("事業 B");
    const first = addReceiptFile(entityId, "a");
    expect((await runOnce("auto")).status).toBe("succeeded");
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(join(storeDir(), entityId, storeName(first)), past, past);
    expect((await runOnce("auto")).status).toBe("skipped");
    // 既にあるものは写し直さない
    expect(statSync(join(storeDir(), entityId, storeName(first))).mtime.getTime()).toBe(
      past.getTime(),
    );

    rmSync(join(storeDir(), entityId, storeName(first)));
    const skipped = await runOnce("auto");
    expect(skipped.status).toBe("skipped");
    expect(storeFiles(entityId)).toEqual([storeName(first)]);
  });

  it("写せなければ failed と RECEIPTS_SYNC_FAILED。`.tbk` を書かず、平文の写しも残さない", async () => {
    const entityId = await createTestEntity("事業 B");
    const sha = addReceiptFile(entityId, "a");
    rmSync(receiptFile(entityId, sha)); // データ場所のファイルが欠けた

    const run = await runOnce("manual");

    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("RECEIPTS_SYNC_FAILED");
    expect(run.fileName).toBeNull();
    expect(env.files().filter((n) => n.endsWith(".tbk"))).toEqual([]);
    expect(storeFiles(entityId)).toEqual([]);
    expect(env.snapshotLeftovers()).toEqual([]);
    expect(await env.backups().getLastSuccess()).toBeUndefined();
  });

  it("証憑が 0 件なら今までどおり（置き場所に trebuchet-receipts/ を作らない）", async () => {
    const run = await runOnce("manual");
    expect(run.status).toBe("succeeded");
    expect(env.files()).toEqual([run.fileName]);
  });

  it("世代の整理は `.tbk` だけ。証憑の写しは消さない", async () => {
    const entityId = await createTestEntity("事業 B");
    const sha = addReceiptFile(entityId, "a");
    for (let i = 0; i < 4; i += 1) await runOnce("manual", 40 * DAY);
    expect(storeFiles(entityId)).toEqual([storeName(sha)]);
  });
});

describe("世代の整理", () => {
  it("この Mac の古いファイルだけを整理し、ほかの Mac のファイルは消さない", async () => {
    const macId = await env.auth().getOrCreateMacId(() => "0192f3a0-1111-7000-8000-000000000001");
    const own1 = backupFileName(macId, new Date("2026-09-01T01:00:00Z"));
    const own2 = backupFileName(macId, new Date("2026-09-01T02:00:00Z"));
    const other1 = backupFileName(
      "abcdef01-2222-7000-8000-000000000002",
      new Date("2026-09-01T01:00:00Z"),
    );
    const other2 = backupFileName(
      "abcdef01-2222-7000-8000-000000000002",
      new Date("2026-09-01T02:00:00Z"),
    );
    for (const name of [own1, own2, other1, other2]) writeFileSync(join(env.folder, name), "x");
    const run = await runOnce("manual");
    expect(run.status).toBe("succeeded");
    const files = env.files();
    expect(files).not.toContain(own1); // 同じ月の古い方
    expect(files).toContain(own2);
    expect(files).toContain(other1);
    expect(files).toContain(other2);
    expect(files).toContain(run.fileName);
  });
});

describe("同時実行と未設定", () => {
  it("実行中の再要求は BACKUP_RUNNING。終われば次を始められる", async () => {
    const first = await env.runner.start("manual");
    if (!first.ok) throw new Error("start failed");
    const second = await env.runner.start("manual");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("BACKUP_RUNNING");
    await first.value.done;
    env.clock.advance(1000);
    expect((await env.runner.start("manual")).ok).toBe(true);
  });

  it("置き場所が未設定なら BACKUP_NOT_CONFIGURED。実行中の印は残らない", async () => {
    const fresh = useTempDataDir("server"); // 設定のない registry
    try {
      const env2 = makeBackupEnv(fresh);
      const started = await env2.runner.start("manual");
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.code).toBe("BACKUP_NOT_CONFIGURED");
      expect(env2.runner.isRunning()).toBe(false);
    } finally {
      fresh.cleanup();
    }
  });
});

describe("片付けの後に作業場所を作り直さない（.tmp/server-<id>/snap の漏れ）", () => {
  it("終わりを待たない実行があっても、finish（実行の終わりを待つ → 片付け）の後に何も残らない", async () => {
    const started = await env.runner.start("manual"); // done を待たない
    expect(started.ok).toBe(true);
    expect(env.runner.isRunning()).toBe(true);
    await env.finish();
    expect(env.runner.isRunning()).toBe(false);
    expect(existsSync(tmp.dir)).toBe(false);
  });

  it("idle は実行がなければすぐ解決し、実行中は終わりで解決する（失敗した実行でも）", async () => {
    await env.runner.idle();
    rmSync(env.folder, { recursive: true, force: true }); // FOLDER_NOT_FOUND で失敗する実行
    await env.runner.start("manual");
    await env.runner.idle();
    expect(env.runner.isRunning()).toBe(false);
    expect((await env.backups().getLastRun())?.status).toBe("failed");
  });
});

describe("鍵を残さない（INV-51）", () => {
  it("DK・回復キーが backup_runs・app_settings・ファイル名・ログ・置き場所のファイルに出ない", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    await runOnce("manual");
    rmSync(env.folder, { recursive: true, force: true });
    await runOnce("manual"); // 失敗の記録
    mkdirSync(env.folder);
    await runOnce("manual");
    const needles = [
      Buffer.from(TEST_DATA_KEY).toString("hex"),
      Buffer.from(TEST_DATA_KEY).toString("base64"),
      env.recovery.text,
      env.recovery.text.replaceAll("-", ""),
    ];
    const runs = JSON.stringify(await env.backups().listRuns(10));
    const logged = JSON.stringify(logs.map((l) => l.mock.calls));
    for (const needle of needles) {
      expect(runs).not.toContain(needle);
      expect(logged).not.toContain(needle);
    }
    for (const name of env.files()) {
      const bytes = readFileSync(join(env.folder, name));
      expect(bytes.includes(Buffer.from(TEST_DATA_KEY))).toBe(false);
      for (const needle of needles) expect(bytes.includes(Buffer.from(needle))).toBe(false);
    }
    expect((await env.auth().getSetting("backup_folder")) ?? "").not.toContain(needles[2] ?? "");
  });
});
