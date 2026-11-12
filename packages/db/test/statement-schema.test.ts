import { randomUUIDv7 } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 の data-model §1・§3、research R12・R15・R16。DB のトリガー・CHECK・UNIQUE の検査はここに一本化する

let tmp: TempDataDir;
let db: TenantDb;
beforeEach(() => {
  tmp = useTempDataDir("statement-schema");
  db = openTenant(randomUUIDv7());
});
afterEach(() => tmp.cleanup());

const NEW_TABLES = [
  "statement_accounts",
  "statement_batches",
  "statements",
  "statement_candidates",
  "statement_links",
  "inference_rules",
  "inference_rule_history",
  "statement_settings",
  "statement_audit_log",
  "statement_sources",
];

const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);
const all = (sqlText: string, ...params: unknown[]) =>
  db.$client.prepare(sqlText).all(...params) as Record<string, unknown>[];

type Row = Record<string, unknown>;

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

let journalNo = 0;
let seq = 0;
const next = () => {
  seq += 1;
  return seq;
};

function seedPeriod(): string {
  const existing = all("SELECT id FROM fiscal_periods WHERE fiscal_year = 2026")[0];
  if (existing) return existing.id as string;
  const id = randomUUIDv7();
  insert("fiscal_periods", {
    id,
    fiscal_year: 2026,
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    status: "open",
  });
  return id;
}

function seedAccount(code: string): string {
  const id = randomUUIDv7();
  insert("accounts", {
    id,
    code,
    name: `科目${code}`,
    category: "asset",
    normal_side: "debit",
    report_section: "BS_ASSET",
    sort_order: 1,
    is_system: 0,
    is_active: 1,
  });
  return id;
}

function seedJournal(source = "manual"): string {
  const id = randomUUIDv7();
  journalNo += 1;
  insert("journals", {
    id,
    journal_no: journalNo,
    date: "2026-10-31",
    fiscal_period_id: seedPeriod(),
    status: "active",
    source,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
  });
  return id;
}

function seedLine(journalId: string, accountId: string, lineNo = 1): string {
  const id = randomUUIDv7();
  insert("journal_lines", {
    id,
    journal_id: journalId,
    line_no: lineNo,
    side: "debit",
    account_id: accountId,
    amount: 1000,
    tax_category: "OUT_OF_SCOPE",
    tax_amount: 0,
  });
  return id;
}

const accountRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  name: `銀行${next()}`,
  usage: "mixed",
  kind: "bank",
  account_id: null,
  sub_account_id: null,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

function seedStatementAccount(over: Row = {}): string {
  const row = accountRow({ account_id: seedAccount(`1${next()}`.padEnd(4, "0")), ...over });
  insert("statement_accounts", row);
  return row.id as string;
}

const batchRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  origin: "paste",
  input_sha256: "a".repeat(64),
  period_from: "2026-10-01",
  period_to: "2026-10-31",
  count_new: 1,
  count_existing: 0,
  count_unreadable: 0,
  created_at: NOW,
  ...over,
});

function seedBatch(over: Row = {}): string {
  const row = batchRow(over);
  insert("statement_batches", row);
  return row.id as string;
}

const statementRow = (batchId: string, accountId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  batch_id: batchId,
  statement_account_id: accountId,
  stable_key: `key-${next()}`,
  external_id: null,
  date: "2026-10-01",
  amount: -500,
  content: "ランチ",
  normalized_content: "ランチ",
  category_major: null,
  category_minor: null,
  memo: null,
  transfer_flag: 0,
  changed_json: null,
  changed_ack_at: null,
  excluded_at: null,
  excluded_reason: null,
  created_at: NOW,
  ...over,
});

function seedStatement(over: Row = {}) {
  const accountId = (over.statement_account_id as string | undefined) ?? seedStatementAccount();
  const batchId = (over.batch_id as string | undefined) ?? seedBatch();
  const row = statementRow(batchId, accountId, over);
  insert("statements", row);
  return { id: row.id as string, batchId, accountId, row };
}

const ruleRow = (accountId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  normalized_content: "ランチ",
  statement_account_id: null,
  counter_account_id: accountId,
  counter_sub_account_id: null,
  partner_id: null,
  tax_category: "PURCHASE_10",
  purpose: "business",
  description_template: null,
  hits: 0,
  overrides: 0,
  status: "active",
  origin: "approval",
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const auditRow = (over: Row = {}): Row => ({
  id: randomUUIDv7(),
  occurred_at: NOW,
  target_type: "statement",
  target_id: randomUUIDv7(),
  action: "create",
  reason: null,
  before_json: null,
  after_json: null,
  ...over,
});

/** 明細と、その口座の行を持つ仕訳（source = statement）を作る */
function seedLinkable() {
  const s = seedStatement();
  const journalId = seedJournal("statement");
  const lineId = seedLine(journalId, seedAccount(`2${next()}`.padEnd(4, "0")));
  return { ...s, journalId, lineId };
}

const linkRow = (statementId: string, journalId: string, lineId: string, over: Row = {}): Row => ({
  id: randomUUIDv7(),
  statement_id: statementId,
  journal_id: journalId,
  journal_line_id: lineId,
  kind: "created",
  created_at: NOW,
  revoked_at: null,
  revoked_reason: null,
  ...over,
});

describe("006 の表", () => {
  it("新しい表（007 の statement_sources を含む 11 表）がすべて STRICT", () => {
    const rows = all("SELECT name, sql FROM sqlite_schema WHERE type = 'table'") as {
      name: string;
      sql: string;
    }[];
    for (const name of NEW_TABLES) {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      expect(row?.sql, name).toMatch(/\)\s*STRICT$/);
    }
  });
});

describe("statement_accounts（§1.1）", () => {
  it("usage・kind の列挙。名前は一意", () => {
    expect(() =>
      insert("statement_accounts", accountRow({ usage: "x", account_id: seedAccount("1001") })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("statement_accounts", accountRow({ kind: "x", account_id: seedAccount("1002") })),
    ).toThrow(/CHECK/);
    const a = accountRow({ account_id: seedAccount("1003") });
    insert("statement_accounts", a);
    expect(() =>
      insert("statement_accounts", accountRow({ name: a.name, account_id: seedAccount("1004") })),
    ).toThrow(/UNIQUE/);
  });

  it("private は account_id が NULL、ほかは NOT NULL", () => {
    expect(() => insert("statement_accounts", accountRow({ usage: "private" }))).not.toThrow();
    expect(() =>
      insert(
        "statement_accounts",
        accountRow({ usage: "private", account_id: seedAccount("1005") }),
      ),
    ).toThrow(/CHECK/);
    for (const usage of ["business", "mixed"]) {
      expect(() => insert("statement_accounts", accountRow({ usage })), usage).toThrow(/CHECK/);
      expect(() =>
        insert(
          "statement_accounts",
          accountRow({ usage, account_id: seedAccount(`2${next()}`.padEnd(4, "0")) }),
        ),
      ).not.toThrow();
    }
  });
});

describe("statement_batches（§1.2）", () => {
  it("origin の列挙、件数は 0 以上、削除・更新できない", () => {
    expect(() => insert("statement_batches", batchRow({ origin: "csv" }))).toThrow(/CHECK/);
    // 007: mfme_fetch は取りやめた（R13）。file を足した
    expect(() => insert("statement_batches", batchRow({ origin: "mfme_fetch" }))).toThrow(/CHECK/);
    for (const col of ["count_new", "count_existing", "count_unreadable"]) {
      expect(() => insert("statement_batches", batchRow({ [col]: -1 })), col).toThrow(/CHECK/);
    }
    const id = seedBatch({ origin: "file", source_name: "サンプル銀行" });
    expect(() => update("statement_batches", "id = ?", { count_new: 2 }, id)).toThrow(
      /append-only|cannot/,
    );
    expect(() => run("DELETE FROM statement_batches WHERE id = ?", id)).toThrow(
      /cannot be deleted/,
    );
  });
});

describe("statements（§1.3）", () => {
  it("stable_key は一意（INV-40）", () => {
    const s = seedStatement();
    expect(() =>
      insert("statements", statementRow(s.batchId, s.accountId, { stable_key: s.row.stable_key })),
    ).toThrow(/UNIQUE/);
  });

  it("external_id は NULL なら重複でき、値があれば一意", () => {
    const s = seedStatement();
    expect(() => insert("statements", statementRow(s.batchId, s.accountId))).not.toThrow();
    insert("statements", statementRow(s.batchId, s.accountId, { external_id: "e1" }));
    expect(() =>
      insert("statements", statementRow(s.batchId, s.accountId, { external_id: "e1" })),
    ).toThrow(/UNIQUE/);
  });

  it("金額は絶対値 1 兆円未満（0 円は入る）、transfer_flag は 0・1", () => {
    const s = seedStatement();
    const row = (over: Row) => statementRow(s.batchId, s.accountId, over);
    expect(() => insert("statements", row({ amount: 0 }))).not.toThrow();
    expect(() => insert("statements", row({ amount: 1_000_000_000_000 }))).toThrow(/CHECK/);
    expect(() => insert("statements", row({ amount: -1_000_000_000_000 }))).toThrow(/CHECK/);
    expect(() => insert("statements", row({ amount: -999_999_999_999 }))).not.toThrow();
    expect(() => insert("statements", row({ transfer_flag: 2 }))).toThrow(/CHECK/);
  });

  it("外部キー: 回・口座がなければ入らない", () => {
    const s = seedStatement();
    expect(() => insert("statements", statementRow(randomUUIDv7(), s.accountId))).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => insert("statements", statementRow(s.batchId, randomUUIDv7()))).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("changed_json・changed_ack_at・excluded_at・excluded_reason だけ更新できる。削除できない", () => {
    const { id } = seedStatement();
    expect(() =>
      update("statements", "id = ?", { changed_json: "{}", changed_ack_at: NOW }, id),
    ).not.toThrow();
    expect(() => update("statements", "id = ?", { changed_ack_at: null }, id)).not.toThrow();
    expect(() =>
      update("statements", "id = ?", { excluded_at: NOW, excluded_reason: "私用" }, id),
    ).not.toThrow();
    for (const [col, value] of [
      ["amount", -1],
      ["content", "x"],
      ["date", "2026-10-02"],
      ["stable_key", "other"],
      ["external_id", "ex"],
      ["normalized_content", "x"],
      ["memo", "m"],
      ["transfer_flag", 1],
      ["batch_id", seedBatch()],
      ["statement_account_id", seedStatementAccount()],
      ["created_at", "2026-10-26T00:00:00.000Z"],
    ] as const) {
      expect(() => update("statements", "id = ?", { [col]: value }, id), col).toThrow(/statements/);
    }
    expect(() => run("DELETE FROM statements WHERE id = ?", id)).toThrow(/cannot be deleted/);
  });
});

describe("statement_candidates（§1.4）", () => {
  const row = (statementId: string, over: Row = {}): Row => ({
    statement_id: statementId,
    method: "rule",
    purpose: "business",
    confidence: 70,
    reason: "過去の同じ内容の明細 2 件と一致",
    draft_json: "{}",
    rule_id: null,
    model: null,
    created_at: NOW,
    ...over,
  });
  const none = { method: "none", purpose: null, confidence: null, draft_json: null };

  it("method・purpose の列挙、確信度は 0〜100", () => {
    const s = seedStatement();
    expect(() => insert("statement_candidates", row(s.id, { method: "magic" }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(s.id, { purpose: "other" }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(s.id, { confidence: 101 }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(s.id, { confidence: -1 }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(s.id, { confidence: 0 }))).not.toThrow();
  });

  it("none は purpose・confidence・draft が NULL、ほかは purpose・confidence が必須。明細ごとに 1 件", () => {
    const a = seedStatement();
    expect(() =>
      insert("statement_candidates", row(a.id, { ...none, purpose: "business" })),
    ).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(a.id, { ...none, confidence: 10 }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("statement_candidates", row(a.id, { ...none, draft_json: "{}" }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("statement_candidates", row(a.id, { purpose: null }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(a.id, { confidence: null }))).toThrow(/CHECK/);
    expect(() => insert("statement_candidates", row(a.id, none))).not.toThrow();
    expect(() => insert("statement_candidates", row(a.id))).toThrow(/UNIQUE|PRIMARY/);
  });

  it("候補は作り直しで置き換えられる（更新・削除できる）", () => {
    const s = seedStatement();
    insert("statement_candidates", row(s.id));
    expect(() =>
      update("statement_candidates", "statement_id = ?", { confidence: 80 }, s.id),
    ).not.toThrow();
    expect(() =>
      run("DELETE FROM statement_candidates WHERE statement_id = ?", s.id),
    ).not.toThrow();
  });
});

describe("statement_links（§1.5、INV-43）", () => {
  it("kind の列挙", () => {
    const l = seedLinkable();
    expect(() =>
      insert("statement_links", linkRow(l.id, l.journalId, l.lineId, { kind: "x" })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert("statement_links", linkRow(l.id, l.journalId, l.lineId, { kind: "matched" })),
    ).not.toThrow();
  });

  it("有効な結びつきは明細ごとに高々 1 件。失効したものは数えない", () => {
    const l = seedLinkable();
    const line2 = seedLine(l.journalId, seedAccount("3001"), 2);
    const first = linkRow(l.id, l.journalId, l.lineId);
    insert("statement_links", first);
    expect(() => insert("statement_links", linkRow(l.id, l.journalId, line2))).toThrow(/UNIQUE/);
    update("statement_links", "id = ?", { revoked_at: NOW, revoked_reason: "取消" }, first.id);
    expect(() => insert("statement_links", linkRow(l.id, l.journalId, line2))).not.toThrow();
  });

  it("有効な結びつきは仕訳の行ごとに高々 1 件。失効したものは数えない", () => {
    const l = seedLinkable();
    const other = seedStatement();
    const first = linkRow(l.id, l.journalId, l.lineId);
    insert("statement_links", first);
    expect(() => insert("statement_links", linkRow(other.id, l.journalId, l.lineId))).toThrow(
      /UNIQUE/,
    );
    update("statement_links", "id = ?", { revoked_at: NOW, revoked_reason: "取消" }, first.id);
    expect(() => insert("statement_links", linkRow(other.id, l.journalId, l.lineId))).not.toThrow();
  });

  it("行が journal_id の仕訳のものでなければ入らない", () => {
    const l = seedLinkable();
    const otherJournal = seedJournal("manual");
    expect(() => insert("statement_links", linkRow(l.id, otherJournal, l.lineId))).toThrow(
      /journal_line/,
    );
    expect(() => insert("statement_links", linkRow(l.id, l.journalId, l.lineId))).not.toThrow();
  });

  it("外部キー: 明細・仕訳・行がなければ入らない", () => {
    const l = seedLinkable();
    expect(() => insert("statement_links", linkRow(randomUUIDv7(), l.journalId, l.lineId))).toThrow(
      /FOREIGN KEY|journal_line/,
    );
    expect(() => insert("statement_links", linkRow(l.id, randomUUIDv7(), l.lineId))).toThrow(
      /FOREIGN KEY|journal_line/,
    );
    expect(() => insert("statement_links", linkRow(l.id, l.journalId, randomUUIDv7()))).toThrow(
      /FOREIGN KEY|journal_line/,
    );
  });

  it("更新できるのは revoked_at・revoked_reason だけ。削除できない", () => {
    const l = seedLinkable();
    const row = linkRow(l.id, l.journalId, l.lineId);
    insert("statement_links", row);
    for (const [col, value] of [
      ["kind", "matched"],
      ["statement_id", seedStatement().id],
      ["journal_id", seedJournal()],
      ["journal_line_id", randomUUIDv7()],
      ["created_at", "2026-10-26T00:00:00.000Z"],
    ] as const) {
      expect(() => update("statement_links", "id = ?", { [col]: value }, row.id), col).toThrow(
        /statement_links/,
      );
    }
    expect(() =>
      update("statement_links", "id = ?", { revoked_at: NOW, revoked_reason: "誤り" }, row.id),
    ).not.toThrow();
    expect(() => run("DELETE FROM statement_links WHERE id = ?", row.id)).toThrow(
      /cannot be deleted/,
    );
  });
});

describe("inference_rules（§1.6）", () => {
  it("列挙・非負の検査", () => {
    const acc = seedAccount("4001");
    expect(() => insert("inference_rules", ruleRow(acc, { purpose: "x" }))).toThrow(/CHECK/);
    expect(() => insert("inference_rules", ruleRow(acc, { status: "x" }))).toThrow(/CHECK/);
    expect(() => insert("inference_rules", ruleRow(acc, { origin: "x" }))).toThrow(/CHECK/);
    expect(() => insert("inference_rules", ruleRow(acc, { tax_category: "BOGUS" }))).toThrow(
      /FOREIGN KEY|CHECK/,
    );
    expect(() => insert("inference_rules", ruleRow(acc, { hits: -1 }))).toThrow(/CHECK/);
    expect(() => insert("inference_rules", ruleRow(acc, { overrides: -1 }))).toThrow(/CHECK/);
    expect(() => insert("inference_rules", ruleRow(acc, { managed_by: "x" }))).toThrow(/CHECK/);
  });

  it("managed_by は既定 auto。user も入る（T018）", () => {
    const acc = seedAccount("4004");
    insert("inference_rules", ruleRow(acc));
    insert("inference_rules", ruleRow(acc, { normalized_content: "別", managed_by: "user" }));
    expect(
      all("SELECT normalized_content AS c, managed_by AS m FROM inference_rules ORDER BY c"),
    ).toEqual(
      expect.arrayContaining([
        { c: "ランチ", m: "auto" },
        { c: "別", m: "user" },
      ]),
    );
  });

  it("（正規化した内容, 口座 | すべて）は一意。NULL（すべて）どうしも重複できない", () => {
    const acc = seedAccount("4002");
    const sa = seedStatementAccount();
    insert("inference_rules", ruleRow(acc));
    expect(() => insert("inference_rules", ruleRow(acc))).toThrow(/UNIQUE/);
    expect(() =>
      insert("inference_rules", ruleRow(acc, { statement_account_id: sa })),
    ).not.toThrow();
    expect(() => insert("inference_rules", ruleRow(acc, { statement_account_id: sa }))).toThrow(
      /UNIQUE/,
    );
    expect(() =>
      insert("inference_rules", ruleRow(acc, { normalized_content: "別" })),
    ).not.toThrow();
  });
});

describe("inference_rule_history（§1.7）", () => {
  const row = (ruleId: string, over: Row = {}): Row => ({
    id: randomUUIDv7(),
    rule_id: ruleId,
    action: "create",
    before_json: null,
    after_json: "{}",
    statement_id: null,
    at: NOW,
    ...over,
  });
  it("action の列挙。更新・削除できない", () => {
    const rule = ruleRow(seedAccount("4003"));
    insert("inference_rules", rule);
    expect(() => insert("inference_rule_history", row(rule.id as string, { action: "x" }))).toThrow(
      /CHECK/,
    );
    const h = row(rule.id as string);
    insert("inference_rule_history", h);
    expect(() => update("inference_rule_history", "id = ?", { action: "update" }, h.id)).toThrow(
      /append-only/,
    );
    expect(() => run("DELETE FROM inference_rule_history WHERE id = ?", h.id)).toThrow(
      /append-only/,
    );
  });
});

describe("statement_settings（§1.8）", () => {
  const row = (over: Row = {}): Row => ({
    id: 1,
    bulk_threshold: 80,
    external_threshold: 60,
    updated_at: NOW,
    ...over,
  });
  it("1 行だけ。しきい値は 0〜100", () => {
    expect(() => insert("statement_settings", row({ id: 2 }))).toThrow(/CHECK/);
    expect(() => insert("statement_settings", row({ bulk_threshold: 101 }))).toThrow(/CHECK/);
    expect(() => insert("statement_settings", row({ external_threshold: -1 }))).toThrow(/CHECK/);
    expect(() => insert("statement_settings", row())).not.toThrow();
    expect(() => insert("statement_settings", row())).toThrow(/UNIQUE|PRIMARY/);
  });
});

describe("statement_audit_log（§1.10）", () => {
  it("target_type・action の列挙。更新・削除できない", () => {
    expect(() => insert("statement_audit_log", auditRow({ target_type: "x" }))).toThrow(/CHECK/);
    expect(() => insert("statement_audit_log", auditRow({ action: "x" }))).toThrow(/CHECK/);
    const row = auditRow();
    insert("statement_audit_log", row);
    expect(() => update("statement_audit_log", "id = ?", { reason: "x" }, row.id)).toThrow(
      /append-only/,
    );
    expect(() => run("DELETE FROM statement_audit_log WHERE id = ?", row.id)).toThrow(
      /append-only/,
    );
  });
});

describe("007 の変更（statement_sources、作り直した表の保全）", () => {
  const sourceRow = (over: Row = {}): Row => ({
    id: randomUUIDv7(),
    name: `取込元${next()}`,
    fixed_account_name: null,
    header_signature: null,
    mapping_json: "{}",
    last_used_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  });

  it("statement_sources: name は一意・1〜100 字、mapping_json は必須、物理削除できる", () => {
    expect(() => insert("statement_sources", sourceRow({ name: "" }))).toThrow(/CHECK/);
    expect(() => insert("statement_sources", sourceRow({ name: "あ".repeat(101) }))).toThrow(
      /CHECK/,
    );
    expect(() => insert("statement_sources", sourceRow({ mapping_json: null }))).toThrow(
      /NOT NULL/,
    );
    const row = sourceRow({
      name: "あ".repeat(100),
      fixed_account_name: "口座",
      header_signature: "[]",
    });
    expect(() => insert("statement_sources", row)).not.toThrow();
    expect(() => insert("statement_sources", sourceRow({ name: row.name }))).toThrow(/UNIQUE/);
    expect(() => run("DELETE FROM statement_sources WHERE id = ?", row.id)).not.toThrow();
  });

  it("statement_batches.source_name は NULL 可。作り直しの後も 0008 の制約・外部キー・index が残る", () => {
    const id = seedBatch({ source_name: null });
    expect(all("SELECT source_name FROM statement_batches WHERE id = ?", id)[0]?.source_name).toBe(
      null,
    );
    const s = seedStatement({ batch_id: id });
    expect(() => run("DELETE FROM statement_batches WHERE id = ?", id)).toThrow(
      /cannot be deleted/,
    );
    // statements.batch_id → statement_batches.id の外部キーが作り直しの後も statement_batches を指す
    const fks = all("PRAGMA foreign_key_list(statements)").filter((r) => r.from === "batch_id");
    expect(fks.map((r) => r.table)).toEqual(["statement_batches"]);
    expect(() => insert("statements", statementRow(randomUUIDv7(), s.accountId))).toThrow(
      /FOREIGN KEY/,
    );
    expect(all("PRAGMA foreign_key_check")).toEqual([]);
    const indexes = all("PRAGMA index_list(statement_audit_log)").map((r) => r.name);
    expect(indexes).toContain("statement_audit_log_target");
  });

  it("作り直した表のトリガーが 1 つずつ残っている", () => {
    const names = all(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (tbl_name = 'statement_batches' OR tbl_name = 'statement_audit_log') ORDER BY name",
    ).map((r) => r.name);
    expect(names).toEqual([
      "statement_audit_log_no_delete",
      "statement_audit_log_no_update",
      "statement_batches_no_delete",
      "statement_batches_no_update",
    ]);
  });

  it("statement_audit_log: statement_source と delete を受け付ける", () => {
    expect(() =>
      insert(
        "statement_audit_log",
        auditRow({ target_type: "statement_source", action: "delete" }),
      ),
    ).not.toThrow();
    expect(() => insert("statement_audit_log", auditRow({ action: "delete" }))).not.toThrow();
  });
});

describe("journals.source のトリガー（R16）", () => {
  it("statement を含む 6 種を挿入でき、bogus は拒否", () => {
    for (const source of [
      "manual",
      "import_freee",
      "invoice",
      "payment",
      "recurring",
      "statement",
    ]) {
      expect(() => seedJournal(source), source).not.toThrow();
    }
    expect(() => seedJournal("bogus")).toThrow(/source/);
  });

  it("更新でも statement にでき、列挙外にはできない", () => {
    const id = seedJournal("manual");
    expect(() => update("journals", "id = ?", { source: "statement" }, id)).not.toThrow();
    expect(() => update("journals", "id = ?", { source: "bogus" }, id)).toThrow(/source/);
    expect(() => update("journals", "id = ?", { memo: "メモ" }, id)).not.toThrow();
  });

  it("トリガーは 1 つずつ（作り直しで重複しない）", () => {
    const names = all(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'journals_source_%' ORDER BY name",
    ).map((r) => r.name);
    expect(names).toEqual(["journals_source_insert", "journals_source_update"]);
  });
});
