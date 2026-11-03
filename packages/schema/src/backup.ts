import { z } from "zod";
import { Id } from "./primitives.ts";

// 004-auth-backup（contracts/http-api.md、data-model.md §1.6）

const Timestamp = z.string().min(1);
const Count = z.number().int().nonnegative();

export const BackupTrigger = z.enum(["manual", "auto"]);
export type BackupTrigger = z.infer<typeof BackupTrigger>;

export const BackupRunStatus = z.enum(["succeeded", "skipped", "failed"]);
export type BackupRunStatus = z.infer<typeof BackupRunStatus>;

/** 事業体ごとの年度と仕訳の件数（バックアップのマニフェストと同じ形） */
export const BackupEntitySummary = z.object({
  id: Id,
  name: z.string(),
  fiscalYears: z.array(z.object({ year: z.number().int(), journals: Count })),
});
export type BackupEntitySummary = z.infer<typeof BackupEntitySummary>;

export const BackupRun = z.object({
  id: Id,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  trigger: BackupTrigger,
  status: BackupRunStatus,
  /**
   * `FOLDER_NOT_FOUND`・`WRITE_FAILED`・`VERIFY_FAILED`・`SNAPSHOT_FAILED`・`LOCKED`・
   * `RECEIPTS_SYNC_FAILED`（証憑のファイルを置き場所に写せなかった。010）など
   */
  errorCode: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: Count.nullable(),
  contentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  summary: z.array(BackupEntitySummary).nullable(),
});
export type BackupRun = z.infer<typeof BackupRun>;

export const BackupAlertReason = z.enum(["STALE", "LAST_RUN_FAILED"]);
export type BackupAlertReason = z.infer<typeof BackupAlertReason>;

export const BackupStatus = z.object({
  configured: z.literal(true),
  folder: z.string(),
  folderSource: z.enum(["configured", "default"]),
  lastSuccess: Timestamp.nullable(),
  /** 最後の成功または変更なし */
  lastCheck: Timestamp.nullable(),
  lastRun: BackupRun.nullable(),
  alert: z.object({ reason: BackupAlertReason }).nullable(),
  running: z.boolean(),
});
export type BackupStatus = z.infer<typeof BackupStatus>;

/**
 * 置き場所だけ。バックアップの鍵は DK から作る（パスフレーズ・同意は持たない。008 の D9）。
 * 失った Mac の復元は、回復キーで行う
 */
export const BackupSettingsInput = z.object({
  folder: z.string().min(1, "置き場所を入力してください"),
});
export type BackupSettingsInput = z.infer<typeof BackupSettingsInput>;

export const BackupInspection = z.object({
  createdAt: Timestamp,
  macId: z.string().min(1),
  /** 適用済みのマイグレーションの数 */
  appVersion: z.object({ registry: Count, tenant: Count }),
  entities: z.array(BackupEntitySummary),
});
export type BackupInspection = z.infer<typeof BackupInspection>;
