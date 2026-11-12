import { randomUUIDv7 } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";
import {
  auditRow,
  fileRow,
  linkRow,
  type Row,
  readingRow,
  receiptDb,
  receiptRow,
  SHA_A,
  SHA_B,
  SHA_C,
} from "./receipt-db-setup.ts";

// 010 の data-model §1.1〜1.5・§5。表の形（STRICT・CHECK・UNIQUE・循環の外部キー）の検査。
// トリガー（不変・追記のみ）は receipt-integrity.test.ts、seed は closing-repository.test.ts

let tmp: TempDataDir;
let db: TenantDb;
beforeEach(() => {
  tmp = useTempDataDir("receipt-schema");
  db = openTenant(randomUUIDv7());
});
afterEach(() => tmp.cleanup());

// db は beforeEach で作り直すので、道具は呼び出しのたびに今の db に結びつける
const t = () => receiptDb(db);
const run = (sqlText: string, ...params: unknown[]) => t().run(sqlText, ...params);
const all = (sqlText: string, ...params: unknown[]) => t().all(sqlText, ...params);
const insert = (table: string, row: Row) => t().insert(table, row);
const addReceipt = (receiptOver: Row = {}, fileOver: Row = {}) =>
  t().addReceipt(receiptOver, fileOver);
const seedJournal = () => t().seedJournal();

const NEW_TABLES = [
  "receipts",
  "receipt_files",
  "receipt_links",
  "receipt_readings",
  "receipt_audit_log",
];

describe("010 の 5 表（§1）", () => {
  it("5 表が STRICT で、PRAGMA foreign_keys が有効", () => {
    const tables = all("SELECT name, sql FROM sqlite_schema WHERE type = 'table'");
    for (const name of NEW_TABLES) {
      const t = tables.find((r) => r.name === name);
      expect(t, name).toBeDefined();
      expect(t?.sql as string, name).toMatch(/\)\s*STRICT$/);
    }
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  describe("receipts（§1.1）", () => {
    it("値が空の証憑を追加できる（FIELDS_MISSING は業務で扱う）", () => {
      const { id } = addReceipt();
      expect(all("SELECT id, version FROM receipts WHERE id = ?", id)).toEqual([
        { id, version: 1 },
      ]);
    });

    it.each([
      ["channel", { channel: "cloud" }],
      ["category", { category: "photo" }],
      ["amount が 0", { amount: 0 }],
      ["amount が 1e12", { amount: 1_000_000_000_000 }],
      ["partner_name が空白だけ", { partner_name: "  ", partner_key: "x" }],
      ["partner_name が 101 文字", { partner_name: "あ".repeat(101), partner_key: "x" }],
      ["partner_name があるのに partner_key が NULL", { partner_name: "店", partner_key: null }],
      ["partner_name が NULL なのに partner_key がある", { partner_name: null, partner_key: "x" }],
      ["memo が 501 文字", { memo: "あ".repeat(501) }],
      ["deleted_at があるのに deleted_reason が NULL", { deleted_at: NOW, deleted_reason: null }],
      [
        "deleted_reason があるのに deleted_at が NULL",
        { deleted_at: null, deleted_reason: "誤り" },
      ],
      ["version が 0", { version: 0 }],
    ] as [string, Row][])("CHECK 違反を拒否する: %s", (_name, over) => {
      expect(() => addReceipt(over)).toThrow(/CHECK/);
      expect(all("SELECT id FROM receipts")).toEqual([]);
      expect(all("SELECT sha256 FROM receipt_files")).toEqual([]);
    });

    it("境界の値は入る（amount 1 と 999,999,999,999、取引先 100 文字、メモ 500 文字、削除）", () => {
      addReceipt({ amount: 1, current_sha256: SHA_A });
      addReceipt({
        amount: 999_999_999_999,
        partner_name: "あ".repeat(100),
        partner_key: "あ".repeat(100),
        memo: "あ".repeat(500),
        deleted_at: NOW,
        deleted_reason: "重複",
        current_sha256: SHA_B,
      });
      expect(all("SELECT id FROM receipts")).toHaveLength(2);
    });

    it("current_sha256 の外部キーは索引つきで、索引 3 本がある", () => {
      const names = all(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'receipts'",
      )
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string" && n.startsWith("receipts_"));
      expect(names.sort()).toEqual([
        "receipts_amount",
        "receipts_received",
        "receipts_search_date",
      ]);
    });
  });

  describe("循環の外部キー（§1.1、I1）", () => {
    it("追加: 証憑 → ファイルの順でも、ファイル → 証憑の順でも、同じトランザクションなら入る", () => {
      const first = receiptRow({ current_sha256: SHA_A });
      db.$client.transaction(() => {
        insert("receipts", first);
        insert("receipt_files", fileRow(first.id as string, { sha256: SHA_A }));
      })();
      const second = receiptRow({ current_sha256: SHA_B });
      db.$client.transaction(() => {
        insert("receipt_files", fileRow(second.id as string, { sha256: SHA_B }));
        insert("receipts", second);
      })();
      expect(all("SELECT id FROM receipts")).toHaveLength(2);
      expect(all("SELECT sha256 FROM receipt_files")).toHaveLength(2);
    });

    it("差し替え: ファイル → 証憑の更新の順でも、証憑の更新 → ファイルの順でも入る", () => {
      const { id } = addReceipt();
      db.$client.transaction(() => {
        insert("receipt_files", fileRow(id, { sha256: SHA_B, file_version: 2 }));
        run("UPDATE receipts SET current_sha256 = ? WHERE id = ?", SHA_B, id);
      })();
      db.$client.transaction(() => {
        run("UPDATE receipts SET current_sha256 = ? WHERE id = ?", SHA_C, id);
        insert("receipt_files", fileRow(id, { sha256: SHA_C, file_version: 3 }));
      })();
      expect(all("SELECT current_sha256 FROM receipts WHERE id = ?", id)).toEqual([
        { current_sha256: SHA_C },
      ]);
    });

    it("ファイルを欠いたまま終えると、コミットの時点で外部キーの違反になり、全部戻る", () => {
      expect(() =>
        db.$client.transaction(() => {
          insert("receipts", receiptRow({ current_sha256: SHA_A }));
        })(),
      ).toThrow(/FOREIGN KEY/);
      expect(all("SELECT id FROM receipts")).toEqual([]);
    });

    it("証憑を欠いたファイルも、コミットの時点で外部キーの違反になる", () => {
      expect(() =>
        db.$client.transaction(() => {
          insert("receipt_files", fileRow(randomUUIDv7(), { sha256: SHA_A }));
        })(),
      ).toThrow(/FOREIGN KEY/);
      expect(all("SELECT sha256 FROM receipt_files")).toEqual([]);
    });

    it("差し替えで current_sha256 だけ更新してファイルを足さないと失敗する", () => {
      const { id } = addReceipt();
      expect(() =>
        db.$client.transaction(() => {
          run("UPDATE receipts SET current_sha256 = ? WHERE id = ?", SHA_B, id);
        })(),
      ).toThrow(/FOREIGN KEY/);
      expect(all("SELECT current_sha256 FROM receipts WHERE id = ?", id)).toEqual([
        { current_sha256: SHA_A },
      ]);
    });

    it("2 つの外部キーは DEFERRABLE INITIALLY DEFERRED", () => {
      for (const [table, ref] of [
        ["receipts", "receipt_files"],
        ["receipt_files", "receipts"],
      ] as const) {
        const ddl = all("SELECT sql FROM sqlite_schema WHERE name = ?", table)[0]?.sql as string;
        expect(ddl, table).toMatch(
          new RegExp(`REFERENCES \`${ref}\`\\([^)]*\\)[^,]*DEFERRABLE INITIALLY DEFERRED`),
        );
      }
    });
  });

  describe("receipt_files（§1.2）", () => {
    it.each([
      ["sha256 が 63 文字", { sha256: "a".repeat(63) }],
      ["sha256 が大文字", { sha256: "A".repeat(64) }],
      ["sha256 が 16 進でない", { sha256: "g".repeat(64) }],
      ["media_type", { media_type: "image/gif" }],
      ["size_bytes が 0", { size_bytes: 0 }],
      ["size_bytes が 20 MiB + 1", { size_bytes: 20_971_521 }],
      ["file_version が 0", { file_version: 0 }],
      ["width が 0", { width: 0 }],
      ["height が負", { height: -1 }],
      ["full_color が 2", { full_color: 2 }],
      ["channel", { channel: "cloud" }],
    ] as [string, Row][])("CHECK 違反を拒否する: %s", (_name, over) => {
      const receipt = receiptRow({ current_sha256: (over.sha256 as string | undefined) ?? SHA_A });
      expect(() =>
        db.$client.transaction(() => {
          insert("receipts", receipt);
          insert("receipt_files", fileRow(receipt.id as string, over));
        })(),
      ).toThrow(/CHECK/);
    });

    it("境界（size_bytes が 20 MiB、PDF の width/height/full_color が NULL）は入る", () => {
      addReceipt(
        { current_sha256: SHA_A },
        {
          size_bytes: 20_971_520,
          media_type: "application/pdf",
          width: null,
          height: null,
          full_color: null,
        },
      );
      expect(all("SELECT size_bytes FROM receipt_files")).toEqual([{ size_bytes: 20_971_520 }]);
    });

    it("sha256 は PK（事業体の中で一意）、(receipt_id, file_version) も一意", () => {
      const { id } = addReceipt();
      expect(() =>
        insert("receipt_files", fileRow(id, { sha256: SHA_A, file_version: 2 })),
      ).toThrow(/UNIQUE|PRIMARY/);
      expect(() =>
        insert("receipt_files", fileRow(id, { sha256: SHA_B, file_version: 1 })),
      ).toThrow(/UNIQUE/);
    });
  });

  describe("receipt_links（§1.3）", () => {
    it("有効な結びつきは証憑ごとに 1 件だけ（部分 UNIQUE）。閉じたものは何件でも", () => {
      const { id } = addReceipt();
      const j1 = seedJournal();
      const j2 = seedJournal();
      insert("receipt_links", linkRow(id, j1));
      expect(() => insert("receipt_links", linkRow(id, j2))).toThrow(/UNIQUE/);
      insert("receipt_links", linkRow(id, j2, { unlinked_at: NOW, unlink_reason: "付け替え" }));
      insert("receipt_links", linkRow(id, j1, { unlinked_at: NOW, unlink_reason: "付け替え" }));
      expect(all("SELECT id FROM receipt_links")).toHaveLength(3);
    });

    it("unlinked_at と unlink_reason は一方だけ NULL にできない", () => {
      const { id } = addReceipt();
      const j = seedJournal();
      expect(() => insert("receipt_links", linkRow(id, j, { unlinked_at: NOW }))).toThrow(/CHECK/);
      expect(() => insert("receipt_links", linkRow(id, j, { unlink_reason: "誤り" }))).toThrow(
        /CHECK/,
      );
    });

    it("存在しない証憑・仕訳を指せない", () => {
      const { id } = addReceipt();
      expect(() => insert("receipt_links", linkRow(randomUUIDv7(), seedJournal()))).toThrow(
        /FOREIGN KEY/,
      );
      expect(() => insert("receipt_links", linkRow(id, randomUUIDv7()))).toThrow(/FOREIGN KEY/);
    });

    it("仕訳ごとの有効な結びつきの索引がある", () => {
      const rows = all(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'receipt_links_journal'",
      );
      expect(rows[0]?.sql as string).toMatch(/WHERE .*unlinked_at.* IS NULL/);
    });
  });

  describe("receipt_readings（§1.4）", () => {
    it("成功の記録は入る。失敗の記録は候補が全部 NULL", () => {
      const { id, sha256 } = addReceipt();
      insert("receipt_readings", readingRow(id, sha256));
      insert(
        "receipt_readings",
        readingRow(id, sha256, {
          status: "timeout",
          error_code: "AI_TIMEOUT",
          cand_date: null,
          cand_amount: null,
          cand_partner: null,
          cand_account_code: null,
          cand_tax_category: null,
          confidence: null,
        }),
      );
      expect(all("SELECT id FROM receipt_readings")).toHaveLength(2);
    });

    it.each([
      ["status", { status: "pending" }],
      ["失敗なのに候補がある", { status: "failed", error_code: "AI_HTTP_ERROR" }],
      ["成功なのに error_code がある", { error_code: "AI_TIMEOUT" }],
      ["confidence が 101", { confidence: 101 }],
      ["confidence が -1", { confidence: -1 }],
      ["date_match が 2", { date_match: 2 }],
      ["account_match が 2", { account_match: 2 }],
    ] as [string, Row][])("CHECK 違反を拒否する: %s", (_name, over) => {
      const { id, sha256 } = addReceipt();
      expect(() => insert("receipt_readings", readingRow(id, sha256, over))).toThrow(/CHECK/);
    });

    it("存在しないファイルの版を指せない", () => {
      const { id } = addReceipt();
      expect(() => insert("receipt_readings", readingRow(id, SHA_C))).toThrow(/FOREIGN KEY/);
    });
  });

  describe("receipt_audit_log（§1.5）", () => {
    it("証憑の ID で引ける列 receipt_id を持つ（結びつき・読み取りの記録も同じ列で引く）", () => {
      const { id } = addReceipt();
      const other = addReceipt({ current_sha256: SHA_B }).id;
      insert("receipt_audit_log", auditRow(id));
      insert(
        "receipt_audit_log",
        auditRow(id, { target_type: "receipt_link", target_id: randomUUIDv7(), action: "link" }),
      );
      insert(
        "receipt_audit_log",
        auditRow(other, {
          target_type: "receipt_reading",
          target_id: randomUUIDv7(),
          action: "read",
        }),
      );
      expect(
        all("SELECT target_type FROM receipt_audit_log WHERE receipt_id = ?", id),
      ).toHaveLength(2);
      expect(() => insert("receipt_audit_log", auditRow(randomUUIDv7()))).toThrow(/FOREIGN KEY/);
    });

    it.each([
      ["target_type", { target_type: "invoice" }],
      ["action", { action: "dispose" }],
    ] as [string, Row][])("CHECK 違反を拒否する: %s", (_name, over) => {
      const { id } = addReceipt();
      expect(() => insert("receipt_audit_log", auditRow(id, over))).toThrow(/CHECK/);
    });

    it("索引 receipt_audit_log_target と receipt_audit_log_receipt がある", () => {
      const names = all(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'receipt_audit_log'",
      ).map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining(["receipt_audit_log_target", "receipt_audit_log_receipt"]),
      );
    });
  });
});
