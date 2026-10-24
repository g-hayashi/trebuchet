import type { BackupRun, BackupStore, NewBackupRun } from "@trebuchet/domain";
import { desc, inArray, sql } from "drizzle-orm";
import { backupRuns } from "../schema/registry.ts";
import type { RegistryDb } from "../tenant-store.ts";

type Row = typeof backupRuns.$inferSelect;

function toRun(r: Row): BackupRun {
  return {
    id: r.id,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    trigger: r.trigger,
    status: r.status,
    errorCode: r.errorCode,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
    contentSha256: r.contentSha256,
    summary: r.summary === null ? null : (JSON.parse(r.summary) as BackupRun["summary"]),
  };
}

/** 新しい順。同じ時刻なら後に記録した行（rowid が大きい）を新しいとする */
const newestFirst = [desc(backupRuns.finishedAt), desc(sql`${backupRuns}.rowid`)] as const;

/** backup_runs だけ（app_settings は AuthStore の getSetting・setSetting） */
export class DrizzleBackupStore implements BackupStore {
  private readonly db: RegistryDb;

  constructor(db: RegistryDb) {
    this.db = db;
  }

  async recordRun(run: NewBackupRun): Promise<void> {
    this.db
      .insert(backupRuns)
      .values({
        id: run.id,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        trigger: run.trigger,
        status: run.status,
        errorCode: run.errorCode,
        fileName: run.fileName,
        sizeBytes: run.sizeBytes,
        contentSha256: run.contentSha256,
        summary: run.summary === null ? null : JSON.stringify(run.summary),
      })
      .run();
  }

  async getLastRun(): Promise<BackupRun | undefined> {
    const row = this.db
      .select()
      .from(backupRuns)
      .orderBy(...newestFirst)
      .limit(1)
      .get();
    return row === undefined ? undefined : toRun(row);
  }

  async getLastCheck(): Promise<BackupRun | undefined> {
    return this.lastWithStatus(["succeeded", "skipped"]);
  }

  async getLastSuccess(): Promise<BackupRun | undefined> {
    return this.lastWithStatus(["succeeded"]);
  }

  async listRuns(limit: number): Promise<BackupRun[]> {
    return this.db
      .select()
      .from(backupRuns)
      .orderBy(...newestFirst)
      .limit(limit)
      .all()
      .map(toRun);
  }

  private lastWithStatus(statuses: Row["status"][]): BackupRun | undefined {
    const row = this.db
      .select()
      .from(backupRuns)
      .where(inArray(backupRuns.status, statuses))
      .orderBy(...newestFirst)
      .limit(1)
      .get();
    return row === undefined ? undefined : toRun(row);
  }
}
