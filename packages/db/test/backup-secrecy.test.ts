import { randomUUIDv7 } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive } from "../src/backup/archive.ts";
import { encryptBackup } from "../src/backup/crypto.ts";
import { currentAppVersion, snapshotDataDir } from "../src/backup/snapshot.ts";
import { type TempDataDir, TMP_ROOT, useTempDataDir } from "../src/testing.ts";
import { seedAuthRows, seedEntities } from "./backup-fixtures.ts";

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("backup-secrecy");
});
afterEach(() => tmp.cleanup());

describe("SC-006: バックアップのファイルに平文が現れない", () => {
  it("取引先名・摘要・事業体名・決算のメモ・SQLite のヘッダーが、ファイルのバイト列にない", async () => {
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
      const file = await encryptBackup(archive, "a long enough passphrase", {
        appVersion: currentAppVersion(),
        macId: randomUUIDv7(),
        createdAt: new Date().toISOString(),
      });
      for (const needle of [partner, memo, note, "SQLite format 3"]) {
        expect(file.includes(Buffer.from(needle, "utf8")), needle).toBe(false);
      }
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
  });
});
