import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { currentAppVersion, decryptBackup, unpackArchive, withDataKey } from "@trebuchet/db";
import {
  type AuthStore,
  type BackupStore,
  backupAlert,
  type Clock,
  domainError,
} from "@trebuchet/domain";
import { type BackupInspection, BackupSettingsInput, type BackupStatus } from "@trebuchet/schema";
import { Hono } from "hono";
import { DomainException } from "../errors.ts";
import { resolveBackupFolder } from "../lib/backup-folder.ts";
import type { BackupRunner } from "../lib/backup-run.ts";
import { readUpload, uploadLimitFor } from "../lib/upload.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

export type BackupRouteDeps = {
  auth: () => AuthStore;
  backups: () => BackupStore;
  runner: BackupRunner;
  clock: Clock;
  /** 検査のファイルの上限（既定 200 MB）。テストが小さくする */
  inspectMaxBytes?: number;
};

/** 検査に送れるバックアップのファイルの上限（research R13） */
const MAX_INSPECT_BYTES = 200 * 1024 * 1024;

const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

/** 置き場所として使える（絶対パスで、存在するフォルダで、書ける） */
function isUsableFolder(folder: string): boolean {
  try {
    if (!isAbsolute(folder) || !statSync(folder).isDirectory()) return false;
    accessSync(folder, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const invalidBackup = () =>
  domainError(
    "BACKUP_INVALID",
    "このアプリのバックアップではないか、ファイルが壊れています。別の帳簿のバックアップは、復元のコマンドと回復キーで開きます",
  );

export function backupRoutes(deps: BackupRouteDeps) {
  const { auth, backups, runner, clock } = deps;
  const inspectMaxBytes = deps.inspectMaxBytes ?? MAX_INSPECT_BYTES;

  /** 置き場所の設定の直後の最初のバックアップ。`manual` で始め、終わりは待たない */
  async function startFirstRun(): Promise<string | null> {
    const started = await runner.start("manual");
    return started.ok ? started.value.runId : null;
  }

  return new Hono<GuardEnv>()
    .get("/status", async (c) => {
      const a = auth();
      const b = backups();
      const destination = resolveBackupFolder(await a.getSetting("backup_folder"));
      const configured = true;
      const lastSuccess = (await b.getLastSuccess())?.finishedAt ?? null;
      const lastCheck = (await b.getLastCheck())?.finishedAt ?? null;
      const lastRun = (await b.getLastRun()) ?? null;
      const status: BackupStatus = {
        configured,
        ...destination,
        lastSuccess,
        lastCheck,
        lastRun,
        alert: backupAlert({ configured, lastCheck, lastRun, now: clock.now() }),
        running: runner.isRunning(),
      };
      return c.json(status, 200);
    })
    .put("/settings", validate("json", BackupSettingsInput), async (c) => {
      const input = c.req.valid("json");
      if (!isUsableFolder(input.folder)) {
        throw new DomainException(
          domainError(
            "BACKUP_FOLDER_NOT_FOUND",
            "置き場所のフォルダが見つからないか、書き込めません",
          ),
        );
      }
      const a = auth();
      const now = clock.now();
      await a.setSetting("backup_folder", input.folder, now);
      await a.setSetting("backup_force_write", "1", now);
      return c.json({ runId: await startFirstRun() }, 200);
    })
    .post("/run", async (c) => {
      const started = await runner.start("manual");
      if (!started.ok) {
        throw new DomainException(started.error);
      }
      return c.json({ runId: started.value.runId }, 202);
    })
    .get("/runs", async (c) => {
      const raw = c.req.query("limit");
      let limit = DEFAULT_RUN_LIMIT;
      if (raw !== undefined) {
        limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_LIMIT) {
          throw new DomainException(
            domainError("VALIDATION", "入力が正しくありません", {
              issues: [
                { path: ["limit"], message: `1〜${MAX_RUN_LIMIT} の整数で指定してください` },
              ],
            }),
          );
        }
      }
      return c.json({ runs: await backups().listRuns(limit) }, 200);
    })
    .post("/inspect", uploadLimitFor(1, inspectMaxBytes), async (c) => {
      const upload = await readUpload(c, inspectMaxBytes);
      // 解錠中の DK で復号する（008 の D9。パスフレーズはない）。復号はメモリだけで行う（平文をディスクに書かない）。
      // 別の DK のバックアップと壊れたファイルは区別しない
      const decrypted = withDataKey((dk) => decryptBackup(upload.bytes, dk, currentAppVersion()));
      if (!decrypted.ok) {
        throw new DomainException(
          decrypted.error === "VERSION_MISMATCH"
            ? domainError(
                "BACKUP_VERSION_MISMATCH",
                "アプリの版が一致しません。このバックアップを取った版のアプリで復元してください",
              )
            : invalidBackup(),
        );
      }
      const unpacked = unpackArchive(decrypted.value.archive);
      if (!unpacked.ok) throw new DomainException(invalidBackup());
      const { header } = decrypted.value;
      const inspection: BackupInspection = {
        createdAt: header.createdAt,
        macId: header.macId,
        appVersion: header.appVersion,
        entities: unpacked.value.manifest.entities,
      };
      return c.json(inspection, 200);
    });
}
