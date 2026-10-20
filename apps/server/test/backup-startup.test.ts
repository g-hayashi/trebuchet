import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackgroundServices } from "../src/lib/startup.ts";
import { type BackupEnv, configure, makeBackupEnv } from "./backup-helpers.ts";

// T012: server の起動の処理（main.ts が呼ぶ）。古い平文の写しの掃除と、自動のバックアップの開始

let tmp: TempDataDir;
let env: BackupEnv;
beforeEach(() => {
  tmp = useTempDataDir("server");
  env = makeBackupEnv(tmp);
});
afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

const deps = (runner: BackupEnv["runner"] | { start: ReturnType<typeof vi.fn> }) => ({
  runner: runner as BackupEnv["runner"],
  auth: env.auth,
  backups: env.backups,
  secrets: env.secrets,
  clock: env.clock.clock,
  tmpRoot: env.tmpRoot,
});

describe("startBackgroundServices", () => {
  it("前回の異常終了で残った .tmp/backup-snapshot-*/ を消し、ほかのものは消さない", () => {
    const stale = join(env.tmpRoot, "backup-snapshot-0191f5a0-aaaa");
    const other = join(env.tmpRoot, "keep-me");
    for (const dir of [stale, other]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(stale, "registry.sqlite"), "plaintext");
    writeFileSync(join(other, "x"), "x");

    const services = startBackgroundServices(deps(env.runner));
    services.stop();

    expect(services.removedSnapshots).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it("起動の直後に一度判断し、設定済みで最後の確認がなければ自動で実行する", async () => {
    await configure(env);
    const start = vi.fn(async () => ({
      ok: false as const,
      error: { code: "BACKUP_RUNNING" as const, message: "" },
    }));
    const services = startBackgroundServices(deps({ start }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith("auto"));
    services.stop();
  });

  it("未設定なら実行しない", async () => {
    const start = vi.fn();
    const services = startBackgroundServices(deps({ start }));
    await new Promise((r) => setTimeout(r, 20));
    expect(start).not.toHaveBeenCalled();
    services.stop();
  });
});
