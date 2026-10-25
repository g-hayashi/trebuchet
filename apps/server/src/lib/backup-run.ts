import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BackupFileError,
  backupFileName,
  type CryptoOptions,
  createSnapshotDir,
  currentAppVersion,
  decryptBackup,
  encryptBackup,
  listBackupFiles,
  packArchive,
  sha256Hex,
  snapshotDataDir,
  unpackArchive,
  writeBackupFile,
} from "@trebuchet/db";
import {
  type AuthStore,
  type BackupRun,
  type BackupStore,
  type Clock,
  domainError,
  err,
  type IdGenerator,
  ok,
  type Result,
  type SecretStore,
  selectBackupsToPrune,
  shouldSkipBackup,
} from "@trebuchet/domain";
import type { BackupTrigger } from "@trebuchet/schema";
import { BACKUP_PASSPHRASE_KEY } from "./keychain.ts";

export type BackupRunnerDeps = {
  auth: () => AuthStore;
  backups: () => BackupStore;
  secrets: SecretStore;
  clock: Clock;
  ids: IdGenerator;
  /** 帳簿のデータの置き場所（`dataDir()`） */
  dataDir: () => string;
  /** 平文の写しを作る場所（`.tmp/`）。写しは `<tmpRoot>/backup-snapshot-<乱数>/` */
  tmpRoot: string;
  /** テストが鍵導出を軽くするための差し替え */
  crypto?: CryptoOptions;
};

type StartedBackup = { runId: string; done: Promise<BackupRun> };

export type BackupRunner = {
  isRunning(): boolean;
  /**
   * 実行を始める。同時に 1 つだけ（実行中は BACKUP_RUNNING）、置き場所が未設定なら BACKUP_NOT_CONFIGURED。
   * `done` は終わりで解決する（失敗は `failed` の行になる）。拒否されるのは、記録そのものが失敗したときだけ
   */
  start(trigger: BackupTrigger): Promise<Result<StartedBackup>>;
};

/** `backup_runs.error_code`（`FOLDER_NOT_FOUND`・`WRITE_FAILED`・`VERIFY_FAILED` は db の `BackupFileError` と同じ） */
type FailureCode =
  | "FOLDER_NOT_FOUND"
  | "WRITE_FAILED"
  | "VERIFY_FAILED"
  | "PASSPHRASE_MISSING"
  | "SNAPSHOT_FAILED";

class RunFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(code);
    this.code = code;
  }
}

/** 長い同期の処理の間に event loop へ制御を返す（実行中も帳簿の API を使えるように） */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** キーチェーンの失敗（例外）は「使えない」として扱う */
export async function readPassphrase(secrets: SecretStore): Promise<string | undefined> {
  try {
    return await secrets.get(BACKUP_PASSPHRASE_KEY);
  } catch {
    return undefined;
  }
}

export function createBackupRunner(deps: BackupRunnerDeps): BackupRunner {
  let running = false;

  async function execute(
    runId: string,
    trigger: BackupTrigger,
    folder: string,
  ): Promise<BackupRun> {
    // 呼び出し元（202 の応答など）に先に制御を返してから、重い処理を始める
    await yieldToEventLoop();
    const startedAt = deps.clock.now();
    const auth = deps.auth();
    const backups = deps.backups();
    const base = {
      id: runId,
      startedAt,
      trigger,
      errorCode: null,
      fileName: null,
      sizeBytes: null,
      contentSha256: null,
      summary: null,
    };
    try {
      const passphrase = await readPassphrase(deps.secrets);
      if (passphrase === undefined) throw new RunFailure("PASSPHRASE_MISSING");

      // スナップショット（平文の写し。作ったらすぐ消す）→ アーカイブ → 内容の SHA-256
      let tmpDir: string | undefined;
      let archive: Buffer;
      let entities: BackupRun["summary"];
      try {
        tmpDir = createSnapshotDir(deps.tmpRoot);
        const snapshot = snapshotDataDir(deps.dataDir(), tmpDir);
        await yieldToEventLoop();
        archive = packArchive(snapshot);
        entities = snapshot.manifest.entities;
      } catch {
        throw new RunFailure("SNAPSHOT_FAILED");
      } finally {
        if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
      }
      await yieldToEventLoop();
      const sha = sha256Hex(archive);

      // 置き場所の一覧（置き場所がなければここで FOLDER_NOT_FOUND）
      const existing = listBackupFiles(folder);
      const forceWrite = (await auth.getSetting("backup_force_write")) === "1";
      const lastSuccess = await backups.getLastSuccess();
      if (
        shouldSkipBackup({
          trigger,
          forceWrite,
          contentSha256: sha,
          lastSuccess,
          existingFiles: existing.map((f) => f.name),
        })
      ) {
        return await finish({
          ...base,
          status: "skipped",
          contentSha256: lastSuccess?.contentSha256 ?? sha,
          summary: entities,
        });
      }

      // 暗号化 → 置き場所へ書き込み（読み戻しの検証つき）
      // ファイル名は Mac の ID の先頭 8 文字で見分ける。UUIDv7 の先頭は時刻なので v4（乱数）を使う
      const macId = await auth.getOrCreateMacId(() => randomUUID());
      const createdAt = deps.clock.now();
      const appVersion = currentAppVersion();
      const encrypted = await encryptBackup(
        archive,
        passphrase,
        { appVersion, macId, createdAt },
        deps.crypto,
      );
      const fileName = backupFileName(macId, new Date(createdAt));
      await writeBackupFile(folder, fileName, encrypted, async (readBack) => {
        const decrypted = await decryptBackup(readBack, passphrase, appVersion, deps.crypto);
        if (!decrypted.ok) return false;
        const unpacked = unpackArchive(decrypted.value.archive);
        return unpacked.ok && sha256Hex(decrypted.value.archive) === sha;
      });

      if (forceWrite) await auth.setSetting("backup_force_write", "0", deps.clock.now());
      prune(folder, macId, createdAt);
      return await finish({
        ...base,
        status: "succeeded",
        fileName,
        sizeBytes: encrypted.length,
        contentSha256: sha,
        summary: entities,
      });
    } catch (e) {
      return await finish({ ...base, status: "failed", errorCode: failureCode(e) });
    }

    async function finish(row: Omit<BackupRun, "finishedAt">): Promise<BackupRun> {
      const result: BackupRun = { ...row, finishedAt: deps.clock.now() };
      await backups.recordRun(result);
      return result;
    }
  }

  return {
    isRunning: () => running,
    async start(trigger) {
      if (running) {
        return err(
          domainError("BACKUP_RUNNING", "バックアップを実行中です。終わるまでお待ちください"),
        );
      }
      running = true;
      try {
        const folder = await deps.auth().getSetting("backup_folder");
        if (folder === undefined) {
          running = false;
          return err(domainError("BACKUP_NOT_CONFIGURED", "バックアップの置き場所が未設定です"));
        }
        const runId = deps.ids.next();
        const done = execute(runId, trigger, folder)
          .catch((e: unknown) => {
            // 記録そのものが失敗した場合。パスフレーズを含まない種別だけをログに残す
            console.error("backup: 実行の記録に失敗", e instanceof Error ? e.name : "unknown");
            throw e;
          })
          .finally(() => {
            running = false;
          });
        // done を誰も待たなくても未処理の拒否にしない
        done.catch(() => {});
        return ok({ runId, done });
      } catch (e) {
        running = false;
        throw e;
      }
    },
  };

  /** 世代の整理。失敗しても成功の記録は変えない */
  function prune(folder: string, macId: string, now: string): void {
    try {
      for (const f of selectBackupsToPrune(listBackupFiles(folder), macId, now)) {
        rmSync(join(folder, f.name), { force: true });
      }
    } catch {
      // 整理できなくてもバックアップ自体は成功している
    }
  }
}

function failureCode(e: unknown): FailureCode {
  if (e instanceof RunFailure) return e.code;
  if (e instanceof BackupFileError) return e.code;
  return "WRITE_FAILED";
}
