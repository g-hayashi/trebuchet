import { rmSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupRunner } from "../src/lib/backup-run.ts";
import { startBackupScheduler } from "../src/lib/backup-scheduler.ts";
import { type BackupEnv, configure, HOUR, makeBackupEnv } from "./backup-helpers.ts";
import { createTestEntity } from "./helpers.ts";

// T012: 1 時間ごとに「最後の確認から 24 時間以上」を見て、自動のバックアップを実行する

let tmp: TempDataDir;
let env: BackupEnv;
beforeEach(async () => {
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  env = makeBackupEnv(tmp);
});
afterEach(async () => {
  vi.useRealTimers();
  await env.finish();
});

const scheduler = (runner: Pick<BackupRunner, "start"> = env.runner) =>
  startBackupScheduler({
    runner,
    auth: env.auth,
    backups: env.backups,
    clock: env.clock.clock,
    intervalMs: 1000,
  });

const count = async () => (await env.backups().listRuns(100)).length;

describe("判断（tick）", () => {
  it("設定済みで一度も確認がなければ実行し、24 時間たつまでは実行しない", async () => {
    await configure(env);
    const s = scheduler();
    await s.tick();
    expect(await count()).toBe(1);
    expect((await env.backups().getLastRun())?.trigger).toBe("auto");

    env.clock.advance(23 * HOUR);
    await s.tick();
    expect(await count()).toBe(1);

    env.clock.advance(HOUR);
    await s.tick();
    expect(await count()).toBe(2);
    s.stop();
  });

  it("「変更なし」の記録が新しい最後の確認になり、次の 24 時間は実行しない", async () => {
    await configure(env);
    const s = scheduler();
    await s.tick();
    env.clock.advance(24 * HOUR);
    await s.tick();
    expect((await env.backups().getLastRun())?.status).toBe("skipped");
    env.clock.advance(23 * HOUR);
    await s.tick();
    expect(await count()).toBe(2);
    env.clock.advance(HOUR);
    await s.tick();
    expect(await count()).toBe(3);
    s.stop();
  });

  it("置き場所が未設定なら実行しない", async () => {
    const s = scheduler();
    await s.tick();
    expect(await count()).toBe(0);
    s.stop();
  });

  it("失敗した実行は確認にならないので、次の判断でもう一度実行する", async () => {
    await configure(env);
    rmSync(env.folder, { recursive: true, force: true }); // FOLDER_NOT_FOUND で失敗する
    const s = scheduler();
    await s.tick();
    expect((await env.backups().getLastRun())?.status).toBe("failed");
    await s.tick();
    expect(await count()).toBe(2);
    s.stop();
  });
});

describe("タイマー", () => {
  it("間隔ごとに判断し、失敗しても続き、stop で止まる", async () => {
    await configure(env);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let calls = 0;
    const runner = {
      start: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return { ok: false as const, error: { code: "BACKUP_RUNNING" as const, message: "" } };
      }),
    };
    const s = scheduler(runner);
    expect(runner.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner.start).toHaveBeenCalledTimes(2);
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner.start).toHaveBeenCalledTimes(2);
  });

  it("判断が終わる前に次の間隔が来ても、重ねて始めない", async () => {
    await configure(env);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = {
      start: vi.fn(async () => {
        await gate;
        return { ok: false as const, error: { code: "BACKUP_RUNNING" as const, message: "" } };
      }),
    };
    const s = scheduler(runner);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runner.start).toHaveBeenCalledTimes(1);
    release();
    s.stop();
  });
});
