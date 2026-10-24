import { createHash, timingSafeEqual } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type CryptoOptions, currentAppVersion, decryptBackup, unpackArchive } from "@trebuchet/db";
import {
  type AuthStore,
  type BackupStore,
  backupAlert,
  type Clock,
  domainError,
  type SecretStore,
} from "@trebuchet/domain";
import {
  type BackupInspection,
  BackupPassphraseInput,
  BackupSettingsInput,
  type BackupStatus,
  PASSPHRASE_MIN_LENGTH,
} from "@trebuchet/schema";
import { Hono, type MiddlewareHandler } from "hono";
import { DomainException } from "../errors.ts";
import { type BackupRunner, readPassphrase } from "../lib/backup-run.ts";
import { BACKUP_PASSPHRASE_KEY } from "../lib/keychain.ts";
import { readUpload, uploadLimitFor } from "../lib/upload.ts";
import type { GuardEnv } from "../middleware/host.ts";
import { validate } from "../validator.ts";

export type BackupRouteDeps = {
  auth: () => AuthStore;
  backups: () => BackupStore;
  secrets: SecretStore;
  runner: BackupRunner;
  clock: Clock;
  /** 検査のファイルの上限（既定 200 MB）。テストが小さくする */
  inspectMaxBytes?: number;
  /** テストが鍵導出を軽くするための差し替え */
  crypto?: CryptoOptions;
};

/** 検査に送れるバックアップのファイルの上限（research R13） */
export const MAX_INSPECT_BYTES = 200 * 1024 * 1024;

const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

/**
 * パスフレーズが短いときは、スキーマの検証（400）の前に 422 `PASSPHRASE_TOO_SHORT` を返す。
 * 本文が読めない・文字列でないときは、後ろのスキーマの検証に任せる
 */
const passphraseLengthCheck: MiddlewareHandler = async (c, next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return next();
  }
  const passphrase = (body as { passphrase?: unknown } | null)?.passphrase;
  if (typeof passphrase === "string" && passphrase.length < PASSPHRASE_MIN_LENGTH) {
    throw new DomainException(
      domainError(
        "PASSPHRASE_TOO_SHORT",
        `パスフレーズは${PASSPHRASE_MIN_LENGTH}文字以上にしてください`,
      ),
    );
  }
  return next();
};

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
  domainError("BACKUP_INVALID", "パスフレーズが違うか、ファイルが壊れています");

const sha = (value: string): Buffer => createHash("sha256").update(value).digest();
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(sha(a), sha(b));

export function backupRoutes(deps: BackupRouteDeps) {
  const { auth, backups, secrets, runner, clock } = deps;
  const inspectMaxBytes = deps.inspectMaxBytes ?? MAX_INSPECT_BYTES;

  /** 設定・パスフレーズの変更の直後の最初のバックアップ。`manual` で始め、終わりは待たない */
  async function startFirstRun(): Promise<string | null> {
    const started = await runner.start("manual");
    return started.ok ? started.value.runId : null;
  }

  return new Hono<GuardEnv>()
    .get("/status", async (c) => {
      const a = auth();
      const b = backups();
      const folder = (await a.getSetting("backup_folder")) ?? null;
      const configured = folder !== null && (await a.getSetting("backup_passphrase_set")) === "1";
      const passphraseAvailable = (await readPassphrase(secrets)) !== undefined;
      const lastSuccess = (await b.getLastSuccess())?.finishedAt ?? null;
      const lastCheck = (await b.getLastCheck())?.finishedAt ?? null;
      const lastRun = (await b.getLastRun()) ?? null;
      const status: BackupStatus = {
        configured,
        folder,
        lastSuccess,
        lastCheck,
        lastRun,
        alert: backupAlert({
          configured,
          passphraseAvailable,
          lastCheck,
          lastRun,
          now: clock.now(),
        }),
        running: runner.isRunning(),
      };
      return c.json(status, 200);
    })
    .put("/settings", passphraseLengthCheck, validate("json", BackupSettingsInput), async (c) => {
      const input = c.req.valid("json");
      if (input.passphrase !== input.passphraseConfirm) {
        throw new DomainException(
          domainError("PASSPHRASE_MISMATCH", "パスフレーズと確認用の入力が一致しません"),
        );
      }
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
      await secrets.set(BACKUP_PASSPHRASE_KEY, input.passphrase);
      await a.setSetting("backup_folder", input.folder, now);
      await a.setSetting("backup_passphrase_set", "1", now);
      await a.setSetting("backup_force_write", "1", now);
      return c.json({ runId: await startFirstRun() }, 200);
    })
    .put(
      "/passphrase",
      passphraseLengthCheck,
      validate("json", BackupPassphraseInput),
      async (c) => {
        const input = c.req.valid("json");
        const a = auth();
        if ((await a.getSetting("backup_folder")) === undefined) {
          throw new DomainException(
            domainError("BACKUP_NOT_CONFIGURED", "バックアップの置き場所が未設定です"),
          );
        }
        if (input.passphrase !== input.passphraseConfirm) {
          throw new DomainException(
            domainError("PASSPHRASE_MISMATCH", "パスフレーズと確認用の入力が一致しません"),
          );
        }
        // キーチェーン（メモリの代替も）に値があるときは、今のパスフレーズを要る。空のときだけ省ける
        const existing = await readPassphrase(secrets);
        if (
          existing !== undefined &&
          (input.current === undefined || !sameSecret(input.current, existing))
        ) {
          throw new DomainException(domainError("PASSPHRASE_WRONG", "今のパスフレーズが違います"));
        }
        const now = clock.now();
        await secrets.set(BACKUP_PASSPHRASE_KEY, input.passphrase);
        await a.setSetting("backup_passphrase_set", "1", now);
        await a.setSetting("backup_force_write", "1", now);
        return c.json({ runId: await startFirstRun() }, 200);
      },
    )
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
      const passphrase = (await c.req.parseBody()).passphrase;
      if (typeof passphrase !== "string" || passphrase === "") {
        const message = "パスフレーズを入力してください";
        throw new DomainException(
          domainError("VALIDATION", "入力が正しくありません", {
            issues: [{ path: ["passphrase"], message }],
          }),
        );
      }
      // 復号はメモリだけで行う（平文をディスクに書かない）。誤ったパスフレーズと壊れたファイルは区別しない
      const decrypted = await decryptBackup(
        upload.bytes,
        passphrase,
        currentAppVersion(),
        deps.crypto,
      );
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
