import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAuthStore } from "../src/auth-repository.ts";
import { DrizzleBackupStore } from "../src/backup/repository.ts";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// T012: backup_runs の BackupStore（app_settings は AuthStore が扱う）

let tmp: TempDataDir;
let store: DrizzleBackupStore;
beforeEach(() => {
  tmp = useTempDataDir("backup-repository");
  store = new DrizzleBackupStore(openRegistry());
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const run = (id: string, finishedAt: string, over: Record<string, unknown> = {}) => ({
  id,
  startedAt: finishedAt,
  finishedAt,
  trigger: "auto" as const,
  status: "succeeded" as "succeeded" | "skipped" | "failed",
  errorCode: null as string | null,
  fileName: `${id}.tbk` as string | null,
  sizeBytes: 1234 as number | null,
  contentSha256: SHA_A as string | null,
  summary: null as
    | { id: string; name: string; fiscalYears: { year: number; journals: number }[] }[]
    | null,
  ...over,
});

describe("DrizzleBackupStore", () => {
  it("実行がなければ undefined と空の一覧", async () => {
    expect(await store.getLastRun()).toBeUndefined();
    expect(await store.getLastCheck()).toBeUndefined();
    expect(await store.getLastSuccess()).toBeUndefined();
    expect(await store.listRuns(10)).toEqual([]);
  });

  it("記録した行を、summary の JSON も含めてそのまま読み戻せる", async () => {
    const summary = [
      {
        id: "0191f5a0-0000-7000-8000-000000000001",
        name: "事業",
        fiscalYears: [{ year: 2026, journals: 3 }],
      },
    ];
    const r = run("r1", "2026-10-20T01:00:00.000Z", { summary });
    await store.recordRun(r);
    expect(await store.getLastRun()).toEqual(r);
    expect((await store.listRuns(10))[0]).toEqual(r);
  });

  it("失敗の行（null の列）を往復できる", async () => {
    const r = run("r1", "2026-10-20T01:00:00.000Z", {
      status: "failed",
      errorCode: "FOLDER_NOT_FOUND",
      fileName: null,
      sizeBytes: null,
      contentSha256: null,
    });
    await store.recordRun(r);
    expect(await store.getLastRun()).toEqual(r);
  });

  it("listRuns は新しい順で、limit で切る", async () => {
    await store.recordRun(run("r1", "2026-10-20T01:00:00.000Z"));
    await store.recordRun(run("r2", "2026-10-20T02:00:00.000Z"));
    await store.recordRun(run("r3", "2026-10-20T03:00:00.000Z"));
    expect((await store.listRuns(10)).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.listRuns(2)).map((r) => r.id)).toEqual(["r3", "r2"]);
  });

  it("同じ時刻なら後に記録した行が新しい", async () => {
    await store.recordRun(run("r1", "2026-10-20T01:00:00.000Z"));
    await store.recordRun(run("r0", "2026-10-20T01:00:00.000Z", { status: "failed" }));
    expect((await store.getLastRun())?.id).toBe("r0");
  });

  it("直近の成功と直近の確認（skipped を含む）を区別する", async () => {
    await store.recordRun(run("ok", "2026-10-20T01:00:00.000Z"));
    await store.recordRun(
      run("skip", "2026-10-20T02:00:00.000Z", {
        status: "skipped",
        fileName: null,
        contentSha256: SHA_B,
      }),
    );
    await store.recordRun(
      run("bad", "2026-10-20T03:00:00.000Z", { status: "failed", errorCode: "WRITE_FAILED" }),
    );
    expect((await store.getLastRun())?.id).toBe("bad");
    expect((await store.getLastCheck())?.id).toBe("skip");
    expect((await store.getLastSuccess())?.id).toBe("ok");
  });

  it("失敗だけなら、直近の成功も確認もない", async () => {
    await store.recordRun(run("bad", "2026-10-20T03:00:00.000Z", { status: "failed" }));
    expect(await store.getLastCheck()).toBeUndefined();
    expect(await store.getLastSuccess()).toBeUndefined();
  });

  it("app_settings（AuthStore）と backup_runs は別の表", async () => {
    const auth = new DrizzleAuthStore(openRegistry());
    await auth.setSetting("backup_folder", "/x", "2026-10-20T00:00:00.000Z");
    await store.recordRun(run("r1", "2026-10-20T01:00:00.000Z"));
    expect(await auth.getSetting("backup_folder")).toBe("/x");
    expect(await store.listRuns(10)).toHaveLength(1);
  });
});
