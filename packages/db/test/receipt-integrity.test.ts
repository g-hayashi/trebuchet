import { randomUUIDv7 } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import {
  auditRow,
  linkRow,
  NOW,
  type Row,
  readingRow,
  receiptDb,
  SHA_B,
} from "./receipt-db-setup.ts";

// 010 の data-model §1.1〜1.5 のトリガー（0015_receipts_integrity）。表の形は receipt-schema.test.ts

let tmp: TempDataDir;
let db: TenantDb;
beforeEach(() => {
  tmp = useTempDataDir("receipt-integrity");
  db = openTenant(randomUUIDv7());
});
afterEach(() => tmp.cleanup());

const t = () => receiptDb(db);
const all = (sqlText: string, ...params: unknown[]) => t().all(sqlText, ...params);
const run = (sqlText: string, ...params: unknown[]) => t().run(sqlText, ...params);
const insert = (table: string, row: Row) => t().insert(table, row);

/** 5 表に 1 行ずつある状態を作る */
function seedAll() {
  const { id, sha256 } = t().addReceipt();
  const journalId = t().seedJournal();
  const link = linkRow(id, journalId);
  insert("receipt_links", link);
  const reading = readingRow(id, sha256);
  insert("receipt_readings", reading);
  const audit = auditRow(id);
  insert("receipt_audit_log", audit);
  return {
    receiptId: id,
    sha256,
    journalId,
    linkId: link.id as string,
    readingId: reading.id as string,
    auditId: audit.id as string,
  };
}

describe("DELETE の禁止（5 表）", () => {
  it.each([
    ["receipts", "id"],
    ["receipt_files", "sha256"],
    ["receipt_links", "id"],
    ["receipt_readings", "id"],
    ["receipt_audit_log", "id"],
  ])("%s の行は削除できない", (table, key) => {
    seedAll();
    const before = all(`SELECT ${key} FROM ${table}`);
    expect(before).toHaveLength(1);
    expect(() => run(`DELETE FROM ${table}`)).toThrow(new RegExp(`${table} cannot be deleted`));
    expect(all(`SELECT ${key} FROM ${table}`)).toEqual(before);
  });
});

describe("追記のみ・不変の表", () => {
  it("receipt_files は UPDATE できない（どの列も）", () => {
    const { sha256 } = seedAll();
    for (const set of ["size_bytes = 2", "original_name = 'x'", "receipt_id = 'x'", "width = 1"]) {
      expect(() => run(`UPDATE receipt_files SET ${set} WHERE sha256 = ?`, sha256), set).toThrow(
        /receipt_files is immutable/,
      );
    }
  });

  it("receipt_audit_log は UPDATE できない", () => {
    const { auditId } = seedAll();
    expect(() => run("UPDATE receipt_audit_log SET reason = 'x' WHERE id = ?", auditId)).toThrow(
      /receipt_audit_log is append-only/,
    );
    expect(() => run("DELETE FROM receipt_audit_log WHERE id = ?", auditId)).toThrow(
      /receipt_audit_log is append-only|cannot be deleted/,
    );
  });
});

describe("receipts の不変の列と論理削除", () => {
  it.each([
    ["received_at", "'2026-11-03T00:00:00.000Z'"],
    ["channel", "'remote'"],
    ["id", "'other-id'"],
  ])("%s は変えられない", (column, value) => {
    const { receiptId } = seedAll();
    expect(() => run(`UPDATE receipts SET ${column} = ${value} WHERE id = ?`, receiptId)).toThrow(
      /receipts\.received_at, channel and id are immutable/,
    );
  });

  it("値・版・更新日時・current_sha256 は変えられる（FK は同じトランザクションの中で満たす）", () => {
    const { receiptId } = seedAll();
    run(
      "UPDATE receipts SET amount = 1100, partner_name = '店', partner_key = '店', memo = 'm', version = 2, updated_at = ? WHERE id = ?",
      "2026-11-03T00:00:00.000Z",
      receiptId,
    );
    db.$client.transaction(() => {
      insert("receipt_files", {
        sha256: SHA_B,
        receipt_id: receiptId,
        file_version: 2,
        media_type: "image/png",
        size_bytes: 10,
        original_name: "b.png",
        width: null,
        height: null,
        full_color: null,
        added_at: NOW,
        channel: "local",
      });
      run("UPDATE receipts SET current_sha256 = ? WHERE id = ?", SHA_B, receiptId);
    })();
    expect(all("SELECT amount, version, current_sha256 FROM receipts")).toEqual([
      { amount: 1100, version: 2, current_sha256: SHA_B },
    ]);
  });

  it("deleted_at は NULL から値へ 1 回だけ。削除の取り消し・日時の変更・理由の変更はできない", () => {
    const { receiptId } = seedAll();
    run("UPDATE receipts SET deleted_at = ?, deleted_reason = '重複' WHERE id = ?", NOW, receiptId);
    expect(() =>
      run("UPDATE receipts SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?", receiptId),
    ).toThrow(/receipts\.deleted_at can be set only once/);
    expect(() =>
      run("UPDATE receipts SET deleted_at = '2026-12-01T00:00:00.000Z' WHERE id = ?", receiptId),
    ).toThrow(/receipts\.deleted_at can be set only once/);
    expect(() =>
      run("UPDATE receipts SET deleted_reason = '別の理由' WHERE id = ?", receiptId),
    ).toThrow(/receipts\.deleted_at can be set only once/);
    expect(all("SELECT deleted_at, deleted_reason FROM receipts")).toEqual([
      { deleted_at: NOW, deleted_reason: "重複" },
    ]);
  });

  it("削除した後も、ほかの列（メモなど）の UPDATE はトリガーでは止めない（業務で 409 にする）", () => {
    const { receiptId } = seedAll();
    run("UPDATE receipts SET deleted_at = ?, deleted_reason = '重複' WHERE id = ?", NOW, receiptId);
    run("UPDATE receipts SET memo = 'x' WHERE id = ?", receiptId);
    expect(all("SELECT memo FROM receipts")).toEqual([{ memo: "x" }]);
  });
});

describe("receipt_links の UPDATE", () => {
  it("unlinked_at・unlink_reason を NULL から値へ 1 回だけ書ける", () => {
    const { linkId } = seedAll();
    run(
      "UPDATE receipt_links SET unlinked_at = ?, unlink_reason = '誤り' WHERE id = ?",
      NOW,
      linkId,
    );
    expect(all("SELECT unlinked_at, unlink_reason FROM receipt_links")).toEqual([
      { unlinked_at: NOW, unlink_reason: "誤り" },
    ]);
    expect(() => run("UPDATE receipt_links SET unlink_reason = '別' WHERE id = ?", linkId)).toThrow(
      /receipt_links can be unlinked only once/,
    );
    expect(() =>
      run("UPDATE receipt_links SET unlinked_at = NULL, unlink_reason = NULL WHERE id = ?", linkId),
    ).toThrow(/receipt_links can be unlinked only once/);
  });

  it.each([
    ["receipt_id", "'x'"],
    ["journal_id", "'x'"],
    ["linked_at", "'2026-12-01T00:00:00.000Z'"],
    ["id", "'x'"],
  ])("%s は変えられない", (column, value) => {
    const { linkId } = seedAll();
    expect(() => run(`UPDATE receipt_links SET ${column} = ${value} WHERE id = ?`, linkId)).toThrow(
      /receipt_links\.id, receipt_id, journal_id and linked_at are immutable/,
    );
  });
});

describe("receipt_readings の UPDATE（列ごとに NULL から値へ 1 回だけ。L2）", () => {
  it("date_match を書いても account_match は後から書ける。書いた列は 2 度書けない", () => {
    const { readingId } = seedAll();
    run(
      "UPDATE receipt_readings SET compared_at = ?, date_match = 1, amount_match = 0, partner_match = 1 WHERE id = ?",
      NOW,
      readingId,
    );
    // 仕訳の登録の比べは別の機会
    run("UPDATE receipt_readings SET account_match = 1, tax_match = 0 WHERE id = ?", readingId);
    expect(
      all(
        "SELECT compared_at, date_match, amount_match, partner_match, account_match, tax_match FROM receipt_readings",
      ),
    ).toEqual([
      {
        compared_at: NOW,
        date_match: 1,
        amount_match: 0,
        partner_match: 1,
        account_match: 1,
        tax_match: 0,
      },
    ]);
    for (const column of [
      "compared_at",
      "date_match",
      "amount_match",
      "partner_match",
      "account_match",
      "tax_match",
    ]) {
      const value = column === "compared_at" ? "'2026-12-01T00:00:00.000Z'" : "0";
      expect(
        () => run(`UPDATE receipt_readings SET ${column} = ${value} WHERE id = ?`, readingId),
        column,
      ).toThrow(/receipt_readings\.\w+ can be set only once/);
    }
  });

  it("まだ NULL の列は、ほかの列が書かれていても書ける（片方だけの書き込みで残りを塞がない）", () => {
    const { readingId } = seedAll();
    run("UPDATE receipt_readings SET date_match = 1 WHERE id = ?", readingId);
    run("UPDATE receipt_readings SET account_match = 0 WHERE id = ?", readingId);
    run("UPDATE receipt_readings SET amount_match = 1 WHERE id = ?", readingId);
    expect(all("SELECT date_match, amount_match, account_match FROM receipt_readings")).toEqual([
      { date_match: 1, amount_match: 1, account_match: 0 },
    ]);
  });

  it.each([
    ["id", "'x'"],
    ["receipt_id", "'x'"],
    ["file_sha256", `'${SHA_B}'`],
    ["read_at", "'2026-12-01T00:00:00.000Z'"],
    ["model", "'other'"],
    ["status", "'failed'"],
    ["cand_amount", "1"],
    ["cand_partner", "'x'"],
    ["confidence", "1"],
  ])("%s は変えられない", (column, value) => {
    const { readingId } = seedAll();
    expect(() =>
      run(`UPDATE receipt_readings SET ${column} = ${value} WHERE id = ?`, readingId),
    ).toThrow(/receipt_readings recorded values are immutable/);
  });

  it("失敗の記録の NULL の候補の列にも値を書けない", () => {
    const { receiptId, sha256 } = seedAll();
    const failed = readingRow(receiptId, sha256, {
      status: "failed",
      error_code: "AI_HTTP_ERROR",
      cand_date: null,
      cand_amount: null,
      cand_partner: null,
      cand_account_code: null,
      cand_tax_category: null,
      confidence: null,
    });
    insert("receipt_readings", failed);
    expect(() =>
      run("UPDATE receipt_readings SET cand_date = '2026-10-31' WHERE id = ?", failed.id),
    ).toThrow(/receipt_readings recorded values are immutable/);
  });
});

describe("結びつき・読み取りの記録を証憑の ID で引ける（INV-63）", () => {
  it("receipt_id で 3 種類の記録が引ける", () => {
    const { receiptId, linkId, readingId } = seedAll();
    insert(
      "receipt_audit_log",
      auditRow(receiptId, { target_type: "receipt_link", target_id: linkId, action: "link" }),
    );
    insert(
      "receipt_audit_log",
      auditRow(receiptId, { target_type: "receipt_reading", target_id: readingId, action: "read" }),
    );
    expect(
      all(
        "SELECT target_type FROM receipt_audit_log WHERE receipt_id = ? ORDER BY rowid",
        receiptId,
      ),
    ).toEqual([
      { target_type: "receipt" },
      { target_type: "receipt_link" },
      { target_type: "receipt_reading" },
    ]);
  });
});
