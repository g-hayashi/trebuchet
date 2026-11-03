import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBackupFolder } from "../src/lib/backup-folder.ts";

afterEach(() => vi.unstubAllEnvs());

describe("バックアップの置き場所", () => {
  it("未設定なら data の設定に依存せずリポジトリ直下の bak を返す（書き込まない）", () => {
    vi.stubEnv("TREBUCHET_DEFAULT_BACKUP_DIR", undefined);
    vi.stubEnv("TREBUCHET_DATA_DIR", "/synthetic-other-data");
    expect(resolveBackupFolder(undefined)).toEqual({
      folder: fileURLToPath(new URL("../../../bak", import.meta.url)),
      folderSource: "default",
    });
  });

  it("環境変数で既定を上書きでき、明示した設定が優先する", () => {
    const folder = fileURLToPath(new URL("../../../.tmp/default-backup", import.meta.url));
    vi.stubEnv("TREBUCHET_DEFAULT_BACKUP_DIR", folder);
    expect(resolveBackupFolder(undefined)).toEqual({ folder, folderSource: "default" });
    expect(resolveBackupFolder("/synthetic-configured")).toEqual({
      folder: "/synthetic-configured",
      folderSource: "configured",
    });
  });
});
