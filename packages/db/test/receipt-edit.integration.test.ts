import { randomUUIDv7 } from "node:crypto";
import {
  addReceipt,
  deleteReceipt,
  getReceiptHistory,
  linkReceipt,
  type ReceiptDeps,
  type ReceiptUnitOfWork,
  type Result,
  replaceReceiptFile,
  replayReceiptHistory,
  unlinkReceipt,
  updateReceipt,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReceiptFileStore } from "../src/receipt-files.ts";
import { createReceiptUnitOfWork } from "../src/receipt-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { receiptDb } from "./receipt-db-setup.ts";

// T027（INV-62・63）: 訂正・差し替え・削除を、実際の drizzleUnitOfWork・暗号化したファイルの置き場所で確かめる。
// 前の版・履歴は残り、失敗した差し替えは行もファイルも残さない

let tmp: TempDataDir;
let db: TenantDb;
let raw: ReturnType<typeof receiptDb>;
let entityId: string;

const NOW = "2026-11-02T09:00:00.000Z";
const ids = { next: () => randomUUIDv7() };
const clock = { now: () => NOW };

beforeEach(() => {
  tmp = useTempDataDir("receipt-edit");
  entityId = createTestEntity().id;
  db = openTenant(entityId);
  raw = receiptDb(db);
});
afterEach(() => tmp.cleanup());

const deps = (uow: ReceiptUnitOfWork = createReceiptUnitOfWork(db)): ReceiptDeps => ({
  uow,
  files: createReceiptFileStore(entityId),
  clock,
  ids,
  dateOf: (iso) => iso.slice(0, 10),
});

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** 先頭が JPEG のマーカーの合成のバイト列（中身の判定だけを通す） */
const jpeg = (label: string) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(label)]);

const add = (label = "first") =>
  unwrap(
    addReceipt(deps(), {
      bytes: jpeg(label),
      originalName: "r.jpg",
      channel: "local",
      options: { category: "electronic", transactionDate: "2026-10-20", amount: 1100 },
      probe: null,
    }),
  );

const replaceInput = (label: string, version: number) => ({
  bytes: jpeg(label),
  originalName: "retake.jpg",
  channel: "remote" as const,
  reason: "撮り直し",
  version,
  probe: null,
});

const count = (table: string) => Number(raw.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n);

describe("訂正・差し替え・削除の往復（実際の DB）", () => {
  it("版・履歴が残り、どの版のファイルも復号でき、履歴を当てると各時点の値に戻る", () => {
    const receipt = add();
    unwrap(updateReceipt(deps(), receipt.id, { version: 1, amount: 2200, reason: "訂正" }));
    const replaced = unwrap(replaceReceiptFile(deps(), receipt.id, replaceInput("second", 2)));
    expect(replaced.currentFile.fileVersion).toBe(2);
    const deleted = unwrap(deleteReceipt(deps(), receipt.id, { reason: "不要", version: 3 }));
    expect(deleted).toMatchObject({ deleted: true, deletedReason: "不要", version: 4 });

    expect(
      raw.all(
        "SELECT file_version, sha256 FROM receipt_files WHERE receipt_id = ? ORDER BY file_version",
        receipt.id,
      ),
    ).toEqual([
      { file_version: 1, sha256: receipt.currentFile.sha256 },
      { file_version: 2, sha256: replaced.currentFile.sha256 },
    ]);
    expect(raw.all("SELECT current_sha256 FROM receipts")[0]?.current_sha256).toBe(
      replaced.currentFile.sha256,
    );
    const files = createReceiptFileStore(entityId);
    for (const sha of [receipt.currentFile.sha256, replaced.currentFile.sha256]) {
      expect(files.digest(files.read(sha))).toBe(sha);
    }

    const history = unwrap(getReceiptHistory(deps(), receipt.id));
    expect(history.map((e) => [e.action, e.reason])).toEqual([
      ["create", null],
      ["update", "訂正"],
      ["replace_file", "撮り直し"],
      ["delete", "不要"],
    ]);
    const createUow = createReceiptUnitOfWork(db);
    const points = createUow.run((tx) => ({
      ok: true as const,
      value: replayReceiptHistory(tx.receipts.listAudit(receipt.id)),
    }));
    if (!points.ok) throw new Error("replay");
    expect(
      points.value.map((p) => [p.values.amount, p.values.currentSha256, p.values.deletedAt]),
    ).toEqual([
      [1100, receipt.currentFile.sha256, null],
      [2200, receipt.currentFile.sha256, null],
      [2200, replaced.currentFile.sha256, null],
      [2200, replaced.currentFile.sha256, NOW],
    ]);
  });

  it("差し替えの書き込みの後でトランザクションが失敗すれば、行も新しいファイルも残らない", () => {
    const receipt = add();
    const inner = createReceiptUnitOfWork(db);
    const failing: ReceiptUnitOfWork = {
      run: (fn) =>
        inner.run((tx) => {
          const result = fn(tx);
          if (result.ok && count("receipt_files") === 2) throw new Error("injected failure");
          return result;
        }),
    };
    const input = replaceInput("second", 1);
    const sha = createReceiptFileStore(entityId).digest(input.bytes);
    expect(() => replaceReceiptFile(deps(failing), receipt.id, input)).toThrow(/injected failure/);
    expect(count("receipt_files")).toBe(1);
    expect(count("receipt_audit_log")).toBe(1);
    expect(raw.all("SELECT current_sha256, version FROM receipts")[0]).toEqual({
      current_sha256: receipt.currentFile.sha256,
      version: 1,
    });
    expect(createReceiptFileStore(entityId).has(sha)).toBe(false);
    expect(createReceiptFileStore(entityId).has(receipt.currentFile.sha256)).toBe(true);
  });

  it("同じ内容の差し替えは RECEIPT_DUPLICATE（UNIQUE に当たる前に止める）", () => {
    const receipt = add();
    const result = replaceReceiptFile(deps(), receipt.id, replaceInput("first", 1));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DUPLICATE", details: { receiptId: receipt.id, deleted: false } },
    });
    expect(count("receipt_files")).toBe(1);
  });

  it("有効な結びつきがあれば削除は RECEIPT_LINKED。解除の後は削除でき、結びつきの行は残る", () => {
    const receipt = add();
    const journalId = raw.seedJournal();
    unwrap(linkReceipt(deps(), receipt.id, { journalId }));
    expect(deleteReceipt(deps(), receipt.id, { reason: "不要", version: 1 })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_LINKED", details: { journalId } },
    });
    unwrap(unlinkReceipt(deps(), receipt.id, { reason: "誤り" }));
    unwrap(deleteReceipt(deps(), receipt.id, { reason: "不要", version: 1 }));
    expect(count("receipt_links")).toBe(1);
    expect(raw.all("SELECT deleted_at FROM receipts")[0]?.deleted_at).toBe(NOW);
  });
});
