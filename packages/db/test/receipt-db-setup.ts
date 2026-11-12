import { randomUUIDv7 } from "node:crypto";
import type { TenantDb } from "../src/tenant-store.ts";
import { NOW } from "../src/testing.ts";

// 010 の db のテストの共通の準備（生の SQL で行を入れる。表の形・トリガーの検査用）

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);

export type Row = Record<string, unknown>;

export const receiptRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  received_at: NOW,
  channel: "local",
  category: "paper_scan",
  current_sha256: SHA_A,
  transaction_date: null,
  amount: null,
  partner_name: null,
  partner_key: null,
  memo: null,
  deleted_at: null,
  deleted_reason: null,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

export const fileRow = (receiptId: string, over: Row = {}): Row => ({
  sha256: SHA_A,
  receipt_id: receiptId,
  file_version: 1,
  media_type: "image/jpeg",
  size_bytes: 1000,
  original_name: "scan.jpg",
  width: 2400,
  height: 1700,
  full_color: 1,
  added_at: NOW,
  channel: "local",
  ...over,
});

export const linkRow = (receiptId: string, journalId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  receipt_id: receiptId,
  journal_id: journalId,
  linked_at: NOW,
  unlinked_at: null,
  unlink_reason: null,
  ...over,
});

export const readingRow = (receiptId: string, sha: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  receipt_id: receiptId,
  file_sha256: sha,
  read_at: NOW,
  model: "gpt-x",
  status: "succeeded",
  error_code: null,
  cand_date: "2026-10-31",
  cand_amount: 1100,
  cand_partner: "店",
  cand_account_code: "5200",
  cand_tax_category: "PURCHASE_10",
  confidence: 80,
  compared_at: null,
  date_match: null,
  amount_match: null,
  partner_match: null,
  account_match: null,
  tax_match: null,
  ...over,
});

export const auditRow = (receiptId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  occurred_at: NOW,
  receipt_id: receiptId,
  target_type: "receipt",
  target_id: receiptId,
  action: "create",
  reason: null,
  before_json: null,
  after_json: "{}",
  ...over,
});

/** 生の SQL で表を操作する道具。`db` は `openTenant` の戻り値 */
export function receiptDb(db: TenantDb) {
  const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);
  const all = (sqlText: string, ...params: unknown[]) =>
    db.$client.prepare(sqlText).all(...params) as Row[];

  function insert(table: string, row: Row): void {
    const cols = Object.keys(row);
    run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...Object.values(row),
    );
  }

  function update(table: string, where: string, set: Row, ...params: unknown[]): void {
    const cols = Object.keys(set);
    run(
      `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${where}`,
      ...Object.values(set),
      ...params,
    );
  }

  /** 追加（証憑 → ファイルの順。同じトランザクションの中。循環の外部キーはコミットで検査される） */
  function addReceipt(receiptOver: Row = {}, fileOver: Row = {}): { id: string; sha256: string } {
    const sha256 = (receiptOver.current_sha256 as string | undefined) ?? SHA_A;
    const receipt = receiptRow({ current_sha256: sha256, ...receiptOver });
    const id = receipt.id as string;
    db.$client.transaction(() => {
      insert("receipts", receipt);
      insert("receipt_files", fileRow(id, { sha256, ...fileOver }));
    })();
    return { id, sha256 };
  }

  function seedJournal(): string {
    let period = all("SELECT id FROM fiscal_periods WHERE fiscal_year = 2026")[0];
    if (!period) {
      insert("fiscal_periods", {
        id: randomUUIDv7(),
        fiscal_year: 2026,
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        status: "open",
      });
      period = all("SELECT id FROM fiscal_periods WHERE fiscal_year = 2026")[0];
    }
    const id = randomUUIDv7();
    const next = all("SELECT COALESCE(MAX(journal_no), 0) + 1 AS n FROM journals")[0]?.n;
    insert("journals", {
      id,
      journal_no: next,
      date: "2026-10-31",
      fiscal_period_id: period?.id,
      status: "active",
      source: "manual",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    return id;
  }

  return { run, all, insert, update, addReceipt, seedJournal };
}
