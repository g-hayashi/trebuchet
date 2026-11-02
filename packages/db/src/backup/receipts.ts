import { createHmac, hkdfSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "../driver.ts";
import { decryptReceipt } from "../receipt-files.ts";
import { isValidEntityId, receiptFile } from "../tenant-store.ts";
import type { SnapshotFile } from "./types.ts";

/**
 * 証憑のファイルのバックアップ（010/R11、data-model §1.8、INV-68）。
 * `.tbk` には入れず、バックアップの置き場所の下の `trebuchet-receipts/<entityId 小文字>/<名前>.trc` に増分で写す。
 * 名前 = `HMAC-SHA256(Kname, 平文の SHA-256)` の 16 進（同期フォルダのクラウドに平文のハッシュを見せない）、
 * `Kname = HKDF-SHA256(DK, 空, "trebuchet/backup/receipt-name/v1")`。中身はデータ場所のファイルと同じバイト列
 * （DK 由来の鍵で暗号化済み。復号し直さない）。DK・Kname・Kfile はディスク・ログ・応答・エラーに出さない
 */

/** バックアップの置き場所の下の、証憑の写しのフォルダ名 */
export const RECEIPT_STORE_DIRNAME = "trebuchet-receipts";

const NAME_KEY_INFO = "trebuchet/backup/receipt-name/v1";

/** 事業体 1 件の、`receipt_files` の `sha256`（重複なし） */
export type ReceiptRefs = { entityId: string; sha256s: string[] };

/** 写せない（データ場所のファイルの欠け・改ざん、置き場所への書き込みの失敗など）。鍵・平文を含めない */
export class ReceiptSyncError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`receipt sync failed: ${reason}`, options);
    this.name = "ReceiptSyncError";
  }
}

/** バックアップの置き場所（`.tbk` のフォルダ）から、証憑の写しのフォルダ */
export const receiptStoreDir = (folder: string): string => join(folder, RECEIPT_STORE_DIRNAME);

/** 置き場所の名前（拡張子 `.trc` を除く 16 進 64 文字）。同じ DK なら毎回同じ */
export function receiptBackupName(dk: Uint8Array, sha256: string): string {
  const kname = Buffer.from(hkdfSync("sha256", dk, Buffer.alloc(0), NAME_KEY_INFO, 32));
  try {
    return createHmac("sha256", kname).update(sha256, "utf8").digest("hex");
  } finally {
    kname.fill(0);
  }
}

const storeFile = (storeDir: string, entityId: string, dk: Uint8Array, sha256: string): string =>
  join(storeDir, entityId.toLowerCase(), `${receiptBackupName(dk, sha256)}.trc`);

const isNotFound = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";

export type SyncOptions = {
  dk: Uint8Array;
  /** `receiptStoreDir(置き場所)` */
  storeDir: string;
  refs: ReceiptRefs[];
  /** 1 件写すごとに呼ぶ（長い処理の間に event loop へ制御を返す用） */
  yieldControl?: () => Promise<void>;
};

/**
 * 置き場所にないものだけを写す。データ場所の `.trc` を読み、`<名前>.partial` に書き、読み戻して
 * `decryptReceipt`（GCM とハッシュ）で検証してから改名する。名前があって大きさが同じものは写さない
 * （大きさが違えば写し直す）。1 件でも写せなければ `ReceiptSyncError`
 */
export async function syncReceiptsToStore(
  options: SyncOptions,
): Promise<{ copied: number; present: number }> {
  const { dk, storeDir } = options;
  let copied = 0;
  let present = 0;
  for (const ref of options.refs) {
    if (!isValidEntityId(ref.entityId)) throw new ReceiptSyncError("invalid entity id");
    for (const sha256 of new Set(ref.sha256s)) {
      const outcome = copyOne(storeDir, ref.entityId, sha256, dk);
      if (outcome === "copied") {
        copied += 1;
        await options.yieldControl?.();
      } else present += 1;
    }
  }
  return { copied, present };
}

function copyOne(
  storeDir: string,
  entityId: string,
  sha256: string,
  dk: Uint8Array,
): "copied" | "present" {
  let dest: string;
  let source: string;
  try {
    dest = storeFile(storeDir, entityId, dk, sha256);
    source = receiptFile(entityId, sha256);
  } catch (cause) {
    throw new ReceiptSyncError("invalid receipt reference", { cause });
  }
  let sourceSize: number | undefined;
  try {
    sourceSize = statSync(source).size;
  } catch (cause) {
    if (!isNotFound(cause)) throw new ReceiptSyncError("cannot read the receipt file", { cause });
  }
  if (existsSync(dest)) {
    // データ場所のファイルが読めなくても、置き場所にあれば INV-68 は満たされる
    if (sourceSize === undefined || statSync(dest).size === sourceSize) return "present";
  } else if (sourceSize === undefined) {
    throw new ReceiptSyncError("receipt file is missing in the data directory");
  }

  const partial = `${dest}.partial`;
  try {
    const bytes = readFileSync(source);
    mkdirSync(join(storeDir, entityId.toLowerCase()), { recursive: true });
    writeFileSync(partial, bytes, { mode: 0o600 });
    // 読み戻して、この DK・この事業体・この名前で復号できることを確かめてから改名する
    decryptReceipt(readFileSync(partial), entityId, sha256, dk).fill(0);
    renameSync(partial, dest);
    return "copied";
  } catch (cause) {
    rmSync(partial, { force: true });
    throw new ReceiptSyncError("cannot copy the receipt file", { cause });
  }
}

/**
 * 写した事業体の DB（平文の写し。`tenants/<id>.sqlite`）の `receipt_files.sha256` を読む。
 * `snapshotDataDir` の結果をそのまま渡せる（書き込まれる前に、スナップショットの時点の参照を確定する）。
 * 事業体の DB 以外は読まない。`receipt_files` の表がなければ空
 */
export function receiptRefsFromSnapshotFiles(files: readonly SnapshotFile[]): ReceiptRefs[] {
  const refs: ReceiptRefs[] = [];
  for (const file of files) {
    const match = /^tenants\/([0-9a-f-]{36})\.sqlite$/i.exec(file.path);
    if (match === null || match[1] === undefined) continue;
    const db = new Database(file.bytes);
    try {
      const table = db
        .prepare(
          "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'receipt_files'",
        )
        .get();
      const rows =
        table === undefined
          ? []
          : (db.prepare("SELECT DISTINCT sha256 FROM receipt_files ORDER BY sha256").all() as {
              sha256: string;
            }[]);
      refs.push({ entityId: match[1].toLowerCase(), sha256s: rows.map((r) => r.sha256) });
    } finally {
      db.close();
    }
  }
  return refs;
}

export type RestoreReceiptsOptions = {
  /** バックアップの DK */
  dk: Uint8Array;
  /** 証憑の写しのフォルダ（`trebuchet-receipts/`） */
  storeDir: string;
  refs: ReceiptRefs[];
  /** `<事業体 ID>/<sha256>.trc` を書くフォルダ（展開先の `receipts/`） */
  targetDir: string;
};

/**
 * 置き場所から読み、バックアップの DK で `decryptReceipt`（AAD と SHA-256 の検証）してから、
 * 同じバイト列を `<targetDir>/<entityId>/<sha256>.trc` に書く。欠け・壊れたものは書かずに数える
 * （例外にしない。失敗にするかは呼び出し側が決める）
 */
export function restoreReceiptsFromStore(options: RestoreReceiptsOptions): {
  restored: number;
  missing: number;
} {
  const { dk, storeDir, targetDir } = options;
  let restored = 0;
  let missing = 0;
  for (const ref of options.refs) {
    const entityId = ref.entityId.toLowerCase();
    for (const sha256 of new Set(ref.sha256s)) {
      try {
        // 名前をそのままパスにするので形を検査する（記録の改ざんでもパスの外へ書かない）
        if (!/^[0-9a-f]{64}$/.test(sha256) || !isValidEntityId(entityId)) throw new Error("name");
        const bytes = readFileSync(storeFile(storeDir, entityId, dk, sha256));
        decryptReceipt(bytes, entityId, sha256, dk).fill(0);
        mkdirSync(join(targetDir, entityId), { recursive: true });
        writeFileSync(join(targetDir, entityId, `${sha256}.trc`), bytes, { mode: 0o600 });
        restored += 1;
      } catch {
        missing += 1;
      }
    }
  }
  return { restored, missing };
}
