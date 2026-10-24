import { describe, expect, it } from "vitest";
import { backupAlert, shouldRunAutoBackup, shouldSkipBackup } from "../../src/backup/policy.ts";

const HOUR = 60 * 60 * 1000;
const NOW = "2026-10-20T12:00:00.000Z";
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const SHA = "a".repeat(64);

describe("shouldRunAutoBackup", () => {
  it("確認が一度もなければ true", () => {
    expect(shouldRunAutoBackup(null, NOW)).toBe(true);
    expect(shouldRunAutoBackup(undefined, NOW)).toBe(true);
  });

  it("24時間の境界: 23:59 は false、24:00 は true", () => {
    expect(shouldRunAutoBackup(ago(24 * HOUR - 60_000), NOW)).toBe(false);
    expect(shouldRunAutoBackup(ago(24 * HOUR), NOW)).toBe(true);
    expect(shouldRunAutoBackup(ago(30 * HOUR), NOW)).toBe(true);
  });
});

describe("backupAlert", () => {
  const base = {
    configured: true,
    passphraseAvailable: true,
    lastCheck: ago(HOUR),
    lastRun: { status: "succeeded" as const },
    now: NOW,
  };

  it("設定が未済なら null（ほかの条件にかかわらず）", () => {
    expect(
      backupAlert({
        ...base,
        configured: false,
        passphraseAvailable: false,
        lastCheck: ago(100 * HOUR),
        lastRun: { status: "failed" },
      }),
    ).toBeNull();
  });

  it("パスフレーズが使えないと PASSPHRASE_NEEDED（最優先）", () => {
    expect(
      backupAlert({
        ...base,
        passphraseAvailable: false,
        lastCheck: ago(100 * HOUR),
        lastRun: { status: "failed" },
      }),
    ).toEqual({ reason: "PASSPHRASE_NEEDED" });
  });

  it("48時間の境界", () => {
    expect(backupAlert({ ...base, lastCheck: ago(48 * HOUR - 60_000) })).toBeNull();
    expect(backupAlert({ ...base, lastCheck: ago(48 * HOUR) })).toEqual({ reason: "STALE" });
  });

  it("STALE は LAST_RUN_FAILED より優先", () => {
    expect(
      backupAlert({ ...base, lastCheck: ago(60 * HOUR), lastRun: { status: "failed" } }),
    ).toEqual({ reason: "STALE" });
  });

  it("直近の実行が失敗なら LAST_RUN_FAILED", () => {
    expect(backupAlert({ ...base, lastRun: { status: "failed" } })).toEqual({
      reason: "LAST_RUN_FAILED",
    });
  });

  it("一度も成功・確認がなく、設定済みで直近が失敗なら警告", () => {
    expect(backupAlert({ ...base, lastCheck: null, lastRun: { status: "failed" } })).toEqual({
      reason: "LAST_RUN_FAILED",
    });
  });

  it("設定済みで一度も実行がなければ null", () => {
    expect(backupAlert({ ...base, lastCheck: null, lastRun: null })).toBeNull();
    expect(backupAlert({ ...base, lastCheck: undefined, lastRun: undefined })).toBeNull();
  });

  it("skipped・succeeded が直近なら null", () => {
    expect(backupAlert({ ...base, lastRun: { status: "skipped" } })).toBeNull();
    expect(backupAlert(base)).toBeNull();
  });
});

describe("shouldSkipBackup", () => {
  const input = {
    trigger: "auto" as const,
    forceWrite: false,
    contentSha256: SHA,
    lastSuccess: { contentSha256: SHA, fileName: "trebuchet-abcd1234-20261019-120000.tbk" },
    existingFiles: ["trebuchet-abcd1234-20261019-120000.tbk", "other.tbk"],
  };

  it("3条件が揃った自動だけ true", () => {
    expect(shouldSkipBackup(input)).toBe(true);
  });

  it("SHA が違えば false", () => {
    expect(shouldSkipBackup({ ...input, contentSha256: "b".repeat(64) })).toBe(false);
  });

  it("前回のファイルが置き場所になければ false", () => {
    expect(shouldSkipBackup({ ...input, existingFiles: ["other.tbk"] })).toBe(false);
    expect(shouldSkipBackup({ ...input, existingFiles: [] })).toBe(false);
  });

  it("forceWrite なら false", () => {
    expect(shouldSkipBackup({ ...input, forceWrite: true })).toBe(false);
  });

  it("前回の成功がなければ false", () => {
    expect(shouldSkipBackup({ ...input, lastSuccess: null })).toBe(false);
    expect(shouldSkipBackup({ ...input, lastSuccess: undefined })).toBe(false);
  });

  it("前回の成功の SHA やファイル名が null なら false", () => {
    expect(
      shouldSkipBackup({
        ...input,
        lastSuccess: { contentSha256: null, fileName: input.lastSuccess.fileName },
      }),
    ).toBe(false);
    expect(
      shouldSkipBackup({ ...input, lastSuccess: { contentSha256: SHA, fileName: null } }),
    ).toBe(false);
  });

  it("手動は3条件が揃っても false", () => {
    expect(shouldSkipBackup({ ...input, trigger: "manual" })).toBe(false);
  });
});
