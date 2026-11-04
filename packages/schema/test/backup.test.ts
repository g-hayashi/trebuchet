import { describe, expect, it } from "vitest";
import {
  BackupInspection,
  BackupRun,
  BackupRunStatus,
  BackupSettingsInput,
  BackupStatus,
  BackupTrigger,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const NOW = "2026-10-20T00:00:00.000Z";

describe("BackupSettingsInput", () => {
  it("置き場所だけを受け取る（バックアップの鍵は DK から。パスフレーズ・同意は持たない。008 の D9）", () => {
    expect(BackupSettingsInput.safeParse({ folder: "/Users/x/Backups" }).success).toBe(true);
  });
  it("空の folder は拒否", () => {
    expect(BackupSettingsInput.safeParse({ folder: "" }).success).toBe(false);
    expect(BackupSettingsInput.safeParse({}).success).toBe(false);
  });
  it("パスフレーズの項目は無視される（値に残らない）", () => {
    const parsed = BackupSettingsInput.parse({ folder: "/x", passphrase: "a".repeat(12) });
    expect(Object.keys(parsed)).toEqual(["folder"]);
  });
});

describe("BackupTrigger / BackupRunStatus", () => {
  it("trigger は manual・auto の2種", () => {
    expect([...BackupTrigger.options].sort()).toEqual(["auto", "manual"]);
    expect(BackupTrigger.safeParse("pre_restore").success).toBe(false);
  });
  it("status は succeeded・skipped・failed の3種", () => {
    expect([...BackupRunStatus.options].sort()).toEqual(["failed", "skipped", "succeeded"]);
  });
});

describe("BackupRun", () => {
  const ok = {
    id: ID,
    startedAt: NOW,
    finishedAt: NOW,
    trigger: "auto",
    status: "succeeded",
    errorCode: null,
    fileName: "trebuchet-x.bak",
    sizeBytes: 1024,
    contentSha256: "a".repeat(64),
    summary: [{ id: ID, name: "山田商店", fiscalYears: [{ year: 2025, journals: 10 }] }],
  };
  it("受け付ける", () => {
    expect(BackupRun.safeParse(ok).success).toBe(true);
  });
  it("errorCode・sizeBytes・fileName・contentSha256・summary は null 可", () => {
    expect(
      BackupRun.safeParse({
        ...ok,
        status: "failed",
        errorCode: "FOLDER_NOT_FOUND",
        fileName: null,
        sizeBytes: null,
        contentSha256: null,
        summary: null,
      }).success,
    ).toBe(true);
  });
  it("trigger・status が範囲外なら拒否", () => {
    expect(BackupRun.safeParse({ ...ok, trigger: "pre_restore" }).success).toBe(false);
    expect(BackupRun.safeParse({ ...ok, status: "running" }).success).toBe(false);
  });
});

describe("BackupStatus", () => {
  const run = {
    id: ID,
    startedAt: NOW,
    finishedAt: NOW,
    trigger: "manual",
    status: "succeeded",
    errorCode: null,
    fileName: "f",
    sizeBytes: 1,
    contentSha256: "a".repeat(64),
    summary: null,
  };
  it("未設定でも既定の置き場所で実行できる", () => {
    expect(
      BackupStatus.safeParse({
        configured: true,
        folder: "/bak",
        folderSource: "default",
        lastSuccess: null,
        lastCheck: null,
        lastRun: null,
        alert: null,
        running: false,
      }).success,
    ).toBe(true);
  });
  it.each(["STALE", "LAST_RUN_FAILED"])("alert の reason %s", (reason) => {
    expect(
      BackupStatus.safeParse({
        configured: true,
        folder: "/x",
        folderSource: "configured",
        lastSuccess: NOW,
        lastCheck: NOW,
        lastRun: run,
        alert: { reason },
        running: true,
      }).success,
    ).toBe(true);
  });
  it("alert の reason が範囲外（PASSPHRASE_NEEDED を含む）なら拒否", () => {
    for (const reason of ["OTHER", "PASSPHRASE_NEEDED"]) {
      expect(
        BackupStatus.safeParse({
          configured: true,
          folder: "/x",
          folderSource: "configured",
          lastSuccess: null,
          lastCheck: null,
          lastRun: null,
          alert: { reason },
          running: false,
        }).success,
        reason,
      ).toBe(false);
    }
  });
});

describe("BackupInspection", () => {
  const ok = {
    createdAt: NOW,
    macId: ID,
    appVersion: { registry: 2, tenant: 5 },
    entities: [{ id: ID, name: "山田商店", fiscalYears: [{ year: 2025, journals: 120 }] }],
  };
  it("受け付ける（事業体 0 件も可）", () => {
    expect(BackupInspection.safeParse(ok).success).toBe(true);
    expect(BackupInspection.safeParse({ ...ok, entities: [] }).success).toBe(true);
  });
  it("journals は 0 以上の整数", () => {
    const bad = {
      ...ok,
      entities: [{ id: ID, name: "x", fiscalYears: [{ year: 2025, journals: -1 }] }],
    };
    expect(BackupInspection.safeParse(bad).success).toBe(false);
  });
  it("appVersion の欠落を拒否", () => {
    const { appVersion: _, ...rest } = ok;
    expect(BackupInspection.safeParse(rest).success).toBe(false);
  });
});
