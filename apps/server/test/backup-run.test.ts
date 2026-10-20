import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupFileName } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackupEnv, configure, makeBackupEnv } from "./backup-helpers.ts";
import { createTestEntity } from "./helpers.ts";

// T012: バックアップの実行（スナップショット → 内容の SHA-256 → skip の判断 → 暗号化 → 書き込み → 世代の整理 → 記録）

let tmp: TempDataDir;
let env: BackupEnv;
beforeEach(async () => {
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  env = makeBackupEnv(tmp);
  await configure(env);
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
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

  it("backup_force_write（パスフレーズの変更の後）が立っていれば自動も書き、成功で消える", async () => {
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
    await env.secrets.delete("trebuchet-backup");
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
    env.crypto.state.breakAfter = env.crypto.state.calls + 1; // 暗号化の鍵は正しく、検証の復号だけ別の鍵
    const run = await runOnce("manual");
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("VERIFY_FAILED");
    expect(env.files().sort()).toEqual([older, newer].sort());
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("パスフレーズがなければ PASSPHRASE_MISSING", async () => {
    await env.secrets.delete("trebuchet-backup");
    const run = await runOnce("auto");
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("PASSPHRASE_MISSING");
    expect(env.files()).toEqual([]);
    expect(env.snapshotLeftovers()).toEqual([]);
  });

  it("スナップショットの作成が失敗しても failed で記録し、平文の写しを残さない", async () => {
    const empty = join(tmp.dir, "no-data");
    mkdirSync(empty);
    const env2 = makeBackupEnv(tmp, { dataDirOverride: empty });
    const started = await env2.runner.start("manual");
    if (!started.ok) throw new Error("start failed");
    const run = await started.value.done;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("SNAPSHOT_FAILED");
    expect(env2.snapshotLeftovers()).toEqual([]);
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

describe("パスフレーズを残さない", () => {
  it("backup_runs・app_settings・ファイル名・ログに出ない", async () => {
    const secret = "unique-passphrase-d0f1c2b3-xyz";
    await env.secrets.set("trebuchet-backup", secret);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    await runOnce("manual");
    env.clock.advance(1000);
    await env.secrets.delete("trebuchet-backup");
    await runOnce("manual"); // 失敗の記録
    const runs = JSON.stringify(await env.backups().listRuns(10));
    expect(runs).not.toContain(secret);
    expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain(secret);
    for (const name of env.files()) {
      expect(readFileSync(join(env.folder, name)).includes(Buffer.from(secret))).toBe(false);
    }
    expect((await env.auth().getSetting("backup_folder")) ?? "").not.toContain(secret);
  });
});
