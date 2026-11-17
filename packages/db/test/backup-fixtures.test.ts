import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_FIXTURES_DIR,
  compareSummaries,
  FIXTURE_BACKUP_FILE,
  FIXTURE_EXPECTED_FILE,
  type FixtureExpected,
  summarizeDataDir,
} from "../../../scripts/lib/backup-fixture.ts";
import { readBackupRelease } from "../src/backup/crypto.ts";
import { restoreBackup } from "../src/backup/restore.ts";
import { closeAll } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

/**
 * リリースごとの見本のバックアップ（`fixtures/backups/v<版>/`。`pnpm backup:fixture` で作り、書き換えない）を、
 * 今の版で復元できることを毎回確かめる（ADR 0016、`docs/development.md` の「互換性」）。
 * 復元は `pnpm restore` と同じ `restoreBackup`（古い版は仮の場所で今の版までマイグレーションを当てる）。
 * 復元した帳簿を開き、仕訳・試算表・表ごとの行数を見本の作成時の値（expected.json）と照合する。
 * 今の版で増えた表・列は照合しない。見本にあった表の行は消えていない（行数が減っていない）こと
 */

const versions = existsSync(BACKUP_FIXTURES_DIR)
  ? readdirSync(BACKUP_FIXTURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];

describe("見本のバックアップ", () => {
  it("1 件以上ある（消し忘れ・置き場所の誤りを検知する）", () => {
    expect(versions.length).toBeGreaterThan(0);
  });

  it("フォルダ名は v<リリースの版> で、.tbk と expected.json がある", () => {
    for (const version of versions) {
      expect(version).toMatch(/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
      expect(existsSync(join(BACKUP_FIXTURES_DIR, version, FIXTURE_BACKUP_FILE))).toBe(true);
      expect(existsSync(join(BACKUP_FIXTURES_DIR, version, FIXTURE_EXPECTED_FILE))).toBe(true);
    }
  });
});

describe.each(versions)("見本 %s を今の版で復元する", (version) => {
  let tmp: TempDataDir;
  beforeEach(() => {
    tmp = useTempDataDir("backup-fixtures");
  });
  afterEach(() => tmp.cleanup());

  it("復元でき、仕訳・試算表・表ごとの行数が作成時と一致する", async () => {
    const dir = join(BACKUP_FIXTURES_DIR, version);
    const file = join(dir, FIXTURE_BACKUP_FILE);
    const expected = JSON.parse(
      readFileSync(join(dir, FIXTURE_EXPECTED_FILE), "utf8"),
    ) as FixtureExpected;
    // ヘッダーの release はフォルダ名の版と同じ
    expect(readBackupRelease(readFileSync(file))).toBe(version.slice(1));
    expect(expected.release).toBe(version.slice(1));

    const dest = join(tmp.dir, "restored", "data");
    const result = await restoreBackup({
      file,
      recoveryKey: expected.recoveryKey,
      dataDir: dest,
      tmpRoot: join(tmp.dir, "scratch"),
      confirm: () => true,
    });
    if (!result.ok) throw new Error(`復元に失敗: ${result.error}`);
    expect(result.value.missingReceipts).toBe(0);
    expect(result.value.summary.entities.map((e) => e.id).sort()).toEqual(
      expected.entities.map((e) => e.id).sort(),
    );

    // 復元した帳簿を開く（DK は見本を作ったときと同じテスト用の固定の DK。useTempDataDir が設定済み）
    closeAll();
    process.env.TREBUCHET_DATA_DIR = dest;
    const actual = summarizeDataDir();
    expect(compareSummaries(expected, actual)).toEqual([]);
  }, 60_000);
});
