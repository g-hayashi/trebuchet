import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupFileError,
  backupFileName,
  listBackupFiles,
  writeBackupFile,
} from "../src/backup/file.ts";
import { TMP_ROOT } from "../src/testing.ts";

let folder: string;
beforeEach(() => {
  folder = join(TMP_ROOT, `backup-file-${randomUUIDv7()}`);
  mkdirSync(folder, { recursive: true });
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const MAC = "0192f3a0-1111-7000-8000-000000000001";
const NAME = "trebuchet-0192f3a0-20261031-090000.tbk";

describe("backupFileName", () => {
  it("macId の先頭 8 文字と UTC の日時から作る", () => {
    expect(backupFileName(MAC, new Date("2026-10-31T09:00:05.123Z"))).toBe(
      NAME.replace("090000", "090005"),
    );
    expect(backupFileName(MAC, new Date("2026-10-31T23:59:59Z"))).toBe(
      "trebuchet-0192f3a0-20261031-235959.tbk",
    );
  });
});

describe("writeBackupFile", () => {
  it("読み戻しの検証に成功すると、最終の名前のファイルだけが残る", async () => {
    let seen: Buffer | undefined;
    await writeBackupFile(folder, NAME, Buffer.from("payload"), (b) => {
      seen = b;
      return true;
    });
    expect(seen?.toString()).toBe("payload");
    expect(readdirSync(folder)).toEqual([NAME]);
    expect(readFileSync(join(folder, NAME)).toString()).toBe("payload");
  });

  it("検証が false を返すと VERIFY_FAILED で、最終の名前も .partial も残らない", async () => {
    await expect(
      writeBackupFile(folder, NAME, Buffer.from("x"), () => false),
    ).rejects.toMatchObject({
      code: "VERIFY_FAILED",
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("検証が例外を投げても VERIFY_FAILED で、何も残らない", async () => {
    await expect(
      writeBackupFile(folder, NAME, Buffer.from("x"), () => {
        throw new Error("boom");
      }),
    ).rejects.toBeInstanceOf(BackupFileError);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("存在しないフォルダでは FOLDER_NOT_FOUND", async () => {
    await expect(
      writeBackupFile(join(folder, "nope"), NAME, Buffer.from("x"), () => true),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_FOUND" });
    expect(existsSync(join(folder, "nope"))).toBe(false);
  });

  it("名前の形が違う・パスを含むものは拒否する", async () => {
    for (const bad of ["../x.tbk", "a/b.tbk", "x.txt", ".hidden.tbk", ""]) {
      await expect(
        writeBackupFile(folder, bad, Buffer.from("x"), () => true),
      ).rejects.toBeInstanceOf(BackupFileError);
    }
    expect(readdirSync(folder)).toEqual([]);
  });

  it("途中で失敗しても、先にあった別の世代のファイルは変わらない", async () => {
    writeFileSync(join(folder, NAME), "old");
    await expect(writeBackupFile(folder, NAME, Buffer.from("new"), () => false)).rejects.toThrow();
    expect(readFileSync(join(folder, NAME)).toString()).toBe("old");
    expect(readdirSync(folder)).toEqual([NAME]);
  });
});

describe("listBackupFiles", () => {
  it(".partial と名前の形が違うものを除き、macId と作成日時（UTC）を返す", () => {
    for (const n of [
      NAME,
      "trebuchet-aaaaaaaa-20261101-000000.tbk",
      ".trebuchet-0192f3a0-20261031-100000.tbk.partial",
      "trebuchet-0192f3a0-20261031-100000.tbk.partial",
      "notes.txt",
      "trebuchet-0192f3a0-20261331-100000.tbk",
      "trebuchet-short-20261031-100000.tbk",
    ]) {
      writeFileSync(join(folder, n), "x");
    }
    mkdirSync(join(folder, "trebuchet-bbbbbbbb-20261102-000000.tbk"));
    expect(listBackupFiles(folder)).toEqual([
      { name: NAME, macId: "0192f3a0", createdAt: "2026-10-31T09:00:00.000Z" },
      {
        name: "trebuchet-aaaaaaaa-20261101-000000.tbk",
        macId: "aaaaaaaa",
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  it("存在しないフォルダは FOLDER_NOT_FOUND", () => {
    expect(() => listBackupFiles(join(folder, "nope"))).toThrowError(BackupFileError);
  });
});
