import {
  closeSync,
  type Dirent,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type BackupFileInfo, compareText } from "@trebuchet/domain";

export type BackupFileErrorCode = "FOLDER_NOT_FOUND" | "WRITE_FAILED" | "VERIFY_FAILED";

/** 置き場所への書き込み・一覧の失敗。メッセージにはパスフレーズ・鍵・内容を含めない */
export class BackupFileError extends Error {
  readonly code: BackupFileErrorCode;
  constructor(code: BackupFileErrorCode) {
    super(`backup file error: ${code}`);
    this.name = "BackupFileError";
    this.code = code;
  }
}

/** `trebuchet-<macId 先頭8文字>-<YYYYMMDD-HHmmss>.tbk`（UTC） */
const NAME_PATTERN = /^trebuchet-([0-9a-z]{8})-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tbk$/;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function backupFileName(macId: string, at: Date): string {
  const prefix = macId.slice(0, 8).toLowerCase();
  if (!/^[0-9a-z]{8}$/.test(prefix)) throw new Error("macId の形が違う");
  return `trebuchet-${prefix}-${compactStamp(at)}.tbk`;
}

/**
 * 復元の前に取る今の帳簿のバックアップ: `trebuchet-before-restore-<YYYYMMDD-HHmmss>.tbk`（UTC）。
 * `NAME_PATTERN`（macId の 8 文字）に合わないので、`listBackupFiles` の対象にも世代の整理にもならない
 */
const BEFORE_RESTORE_PATTERN = /^trebuchet-before-restore-\d{8}-\d{6}\.tbk$/;

export function beforeRestoreFileName(at: Date): string {
  return `trebuchet-before-restore-${compactStamp(at)}.tbk`;
}

/** `YYYYMMDD-HHmmss`（UTC） */
export function compactStamp(at: Date): string {
  return (
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  );
}

/** domain の `selectBackupsToPrune` にそのまま渡せるよう、domain の型を使う */
export type { BackupFileInfo };

function parseName(name: string): BackupFileInfo | undefined {
  const m = NAME_PATTERN.exec(name);
  if (m === null) return undefined;
  const [, macId, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  // 13 月などの存在しない日時は、丸められて元の数字に戻らない
  if (compactStamp(date) !== `${y}${mo}${d}-${h}${mi}${s}` || macId === undefined) return undefined;
  return { name, macId, createdAt: date.toISOString() };
}

function isFolder(folder: string): boolean {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 同じフォルダに `.<name>.partial` で書いて fsync し、読み戻して `verify` が true を返したら
 * 最終の名前に rename する（FR-018・022）。失敗したら .partial を消し、最終の名前のファイルを作らない。
 * `verify` は呼び出し側が渡す（復号と展開の検証）。
 */
export async function writeBackupFile(
  folder: string,
  name: string,
  bytes: Uint8Array,
  verify: (readBack: Buffer) => boolean | Promise<boolean>,
): Promise<void> {
  if (parseName(name) === undefined && !BEFORE_RESTORE_PATTERN.test(name)) {
    throw new BackupFileError("WRITE_FAILED");
  }
  if (!isFolder(folder)) throw new BackupFileError("FOLDER_NOT_FOUND");
  const partial = join(folder, `.${name}.partial`);
  try {
    try {
      const fd = openSync(partial, "w", 0o600);
      try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new BackupFileError("WRITE_FAILED");
    }
    let ok = false;
    try {
      ok = await verify(readFileSync(partial));
    } catch {
      ok = false;
    }
    if (!ok) throw new BackupFileError("VERIFY_FAILED");
    try {
      renameSync(partial, join(folder, name));
    } catch {
      throw new BackupFileError("WRITE_FAILED");
    }
  } catch (e) {
    rmSync(partial, { force: true });
    throw e;
  }
}

/** 置き場所のバックアップのファイル（.partial と名前の形が違うものは除く）。作成日時の昇順 */
export function listBackupFiles(folder: string): BackupFileInfo[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    throw new BackupFileError("FOLDER_NOT_FOUND");
  }
  const out: BackupFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = parseName(entry.name);
    if (info !== undefined) out.push(info);
  }
  return out.sort((a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.name, b.name));
}
