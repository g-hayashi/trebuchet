import { describe, expect, it } from "vitest";
import {
  BackupInspection,
  BackupPassphraseInput,
  BackupRun,
  BackupRunStatus,
  BackupSettingsInput,
  BackupStatus,
  BackupTrigger,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const NOW = "2026-10-20T00:00:00.000Z";
const PASS12 = "a".repeat(12);

describe("BackupSettingsInput", () => {
  const ok = {
    folder: "/Users/x/Backups",
    passphrase: PASS12,
    passphraseConfirm: PASS12,
    acknowledged: true,
  };
  it("12文字は可、11文字は拒否", () => {
    expect(BackupSettingsInput.safeParse(ok).success).toBe(true);
    const p11 = "a".repeat(11);
    expect(
      BackupSettingsInput.safeParse({ ...ok, passphrase: p11, passphraseConfirm: p11 }).success,
    ).toBe(false);
  });
  it("日本語のパスフレーズも文字数で数える", () => {
    const p = "あ".repeat(12);
    expect(
      BackupSettingsInput.safeParse({ ...ok, passphrase: p, passphraseConfirm: p }).success,
    ).toBe(true);
  });
  it("acknowledged が false・欠落は拒否", () => {
    expect(BackupSettingsInput.safeParse({ ...ok, acknowledged: false }).success).toBe(false);
    const { acknowledged: _, ...rest } = ok;
    expect(BackupSettingsInput.safeParse(rest).success).toBe(false);
  });
  it("空の folder は拒否", () => {
    expect(BackupSettingsInput.safeParse({ ...ok, folder: "" }).success).toBe(false);
  });
  it.each(["\n", "\r", "\r\n"])("パスフレーズに改行（%j）を含むものを拒否する", (nl) => {
    const p = `${"a".repeat(12)}${nl}b`;
    expect(
      BackupSettingsInput.safeParse({ ...ok, passphrase: p, passphraseConfirm: p }).success,
    ).toBe(false);
  });
  it("不一致は schema では検査しない（server が PASSPHRASE_MISMATCH にする）", () => {
    expect(
      BackupSettingsInput.safeParse({ ...ok, passphraseConfirm: "b".repeat(12) }).success,
    ).toBe(true);
  });
});

describe("BackupPassphraseInput", () => {
  const ok = { passphrase: PASS12, passphraseConfirm: PASS12 };
  it("current なしは可、current ありも可", () => {
    expect(BackupPassphraseInput.safeParse(ok).success).toBe(true);
    expect(BackupPassphraseInput.safeParse({ ...ok, current: "old-pass-phrase" }).success).toBe(
      true,
    );
  });
  it("12文字は可、11文字は拒否", () => {
    const p11 = "a".repeat(11);
    expect(
      BackupPassphraseInput.safeParse({ passphrase: p11, passphraseConfirm: p11 }).success,
    ).toBe(false);
  });
  it.each(["\n", "\r"])("パスフレーズに改行（%j）を含むものを拒否する", (nl) => {
    const p = `${"a".repeat(12)}${nl}b`;
    expect(BackupPassphraseInput.safeParse({ passphrase: p, passphraseConfirm: p }).success).toBe(
      false,
    );
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
  it("未設定", () => {
    expect(
      BackupStatus.safeParse({
        configured: false,
        folder: null,
        lastSuccess: null,
        lastCheck: null,
        lastRun: null,
        alert: null,
        running: false,
      }).success,
    ).toBe(true);
  });
  it.each(["STALE", "LAST_RUN_FAILED", "PASSPHRASE_NEEDED"])("alert の reason %s", (reason) => {
    expect(
      BackupStatus.safeParse({
        configured: true,
        folder: "/x",
        lastSuccess: NOW,
        lastCheck: NOW,
        lastRun: run,
        alert: { reason },
        running: true,
      }).success,
    ).toBe(true);
  });
  it("alert の reason が範囲外なら拒否", () => {
    expect(
      BackupStatus.safeParse({
        configured: true,
        folder: "/x",
        lastSuccess: null,
        lastCheck: null,
        lastRun: null,
        alert: { reason: "OTHER" },
        running: false,
      }).success,
    ).toBe(false);
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
