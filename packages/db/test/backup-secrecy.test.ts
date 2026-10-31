import { randomUUIDv7 } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive } from "../src/backup/archive.ts";
import { encryptBackup } from "../src/backup/crypto.ts";
import { currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import { TEST_DATA_KEY, type TempDataDir, TMP_ROOT, useTempDataDir } from "../src/testing.ts";
import { recoveryFixture, seedAuthRows, seedEntities } from "./backup-fixtures.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-secrecy");
});
afterEach(() => tmp.cleanup());

describe("SC-006: バックアップのファイルに平文が現れない", () => {
  it("取引先名・摘要・事業体名・決算のメモ・SQLite のヘッダー・DK・回復キーが、ファイルのバイト列にない", () => {
    const partner = "株式会社ひみつ商会-取引先";
    const memo = "摘要マーカー-ひみつの買掛";
    const note = "決算メモ-特別な事情です";
    seedEntities([{ name: partner, kind: "corporation", seed: 7, journals: 3, memo, note }]);
    seedAuthRows("secrecy");
    const snapDir = join(TMP_ROOT, `backup-snapshot-${randomUUIDv7()}`);
    try {
      const snap = snapshotDataDir(tmp.dir, snapDir);
      const archive = packArchive(snap);
      // 対照: 暗号化前のアーカイブには平文が現れる（検査が空振りしていないことの確認）
      expect(archive.includes(Buffer.from(memo, "utf8"))).toBe(true);
      expect(archive.includes(Buffer.from("SQLite format 3"))).toBe(true);
      const recovery = recoveryFixture(TEST_DATA_KEY);
      const file = encryptBackup(archive, TEST_DATA_KEY, {
        appVersion: currentAppVersion(),
        macId: randomUUIDv7(),
        createdAt: new Date().toISOString(),
        recoveryWrap: recovery.wrap,
      });
      for (const needle of [partner, memo, note, "SQLite format 3"]) {
        expect(file.includes(Buffer.from(needle, "utf8")), needle).toBe(false);
      }
      // INV-51: DK・回復キーはファイルに現れない（ヘッダーには包んだ DK だけがある）
      for (const needle of [
        Buffer.from(TEST_DATA_KEY),
        Buffer.from(TEST_DATA_KEY).toString("base64"),
        Buffer.from(TEST_DATA_KEY).toString("hex"),
        recovery.text,
        recovery.text.replaceAll("-", ""),
      ]) {
        expect(file.includes(needle), String(needle)).toBe(false);
      }
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
  });
});
