import { z } from "zod";
import { Id } from "./primitives.ts";

// 004-auth-backup（contracts/http-api.md、data-model.md §1.6）

const Timestamp = z.string().min(1);
const Count = z.number().int().nonnegative();

/** パスフレーズ。12文字以上。改行（\n、\r）を含むものは拒否する（キーチェーンへの保存の入力が1行のため。R12） */
/** server はスキーマの検証の前にこの長さを見て 422 `PASSPHRASE_TOO_SHORT` を返す */
export const PASSPHRASE_MIN_LENGTH = 12;

const Passphrase = z
  .string()
  .min(PASSPHRASE_MIN_LENGTH, "パスフレーズは12文字以上にしてください")
  .regex(/^[^\r\n]*$/, "パスフレーズに改行は使えません");

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
  /** `FOLDER_NOT_FOUND`・`WRITE_FAILED`・`VERIFY_FAILED`・`PASSPHRASE_MISSING` など */
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

export const BackupAlertReason = z.enum(["STALE", "LAST_RUN_FAILED", "PASSPHRASE_NEEDED"]);
export type BackupAlertReason = z.infer<typeof BackupAlertReason>;

export const BackupStatus = z.object({
  configured: z.boolean(),
  folder: z.string().nullable(),
  lastSuccess: Timestamp.nullable(),
  /** 最後の成功または変更なし */
  lastCheck: Timestamp.nullable(),
  lastRun: BackupRun.nullable(),
  alert: z.object({ reason: BackupAlertReason }).nullable(),
  running: z.boolean(),
});
export type BackupStatus = z.infer<typeof BackupStatus>;

/** 不一致（`PASSPHRASE_MISMATCH`）は server が検査する */
export const BackupSettingsInput = z.object({
  folder: z.string().min(1, "置き場所を入力してください"),
  passphrase: Passphrase,
  passphraseConfirm: z.string(),
  /** 「パスフレーズを失うと復元できない」ことへの同意 */
  acknowledged: z.literal(true),
});
export type BackupSettingsInput = z.infer<typeof BackupSettingsInput>;

export const BackupPassphraseInput = z.object({
  /** キーチェーン（使えない環境ではメモリ）が空のときだけ省略できる */
  current: z.string().optional(),
  passphrase: Passphrase,
  passphraseConfirm: z.string(),
});
export type BackupPassphraseInput = z.infer<typeof BackupPassphraseInput>;

export const BackupInspection = z.object({
  createdAt: Timestamp,
  macId: z.string().min(1),
  /** 適用済みのマイグレーションの数 */
  appVersion: z.object({ registry: Count, tenant: Count }),
  entities: z.array(BackupEntitySummary),
});
export type BackupInspection = z.infer<typeof BackupInspection>;
