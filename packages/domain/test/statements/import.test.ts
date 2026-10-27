import { beforeEach, describe, expect, it } from "vitest";
import type { StatementRow } from "../../src/statements/table.ts";
import type { Result } from "../../src/types.ts";
import {
  commitStatementImport,
  commitStatementRows,
  detectStatementLayout,
  listStatementAccounts,
  listStatementBatches,
  previewStatementImport,
  previewStatementRows,
  saveStatementAccount,
} from "../../src/usecases/statements.ts";
import { fakeStatementUnitOfWork } from "../fakes.ts";
import { MFME_PASTE } from "../fixtures/statements/expected.ts";
import { readStatementText } from "../fixtures/statements/load.ts";
import { setupBase } from "../ledger-setup.ts";
import { statementTableOf } from "../statements-arbitraries.ts";

// 006 T009（R4・R14・R18、§1.1〜§1.3、FR-002〜007）・007 T008（H:§2.1〜2.3）。
// 口座の対応・表の判定・取込のプレビューと確定

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function setup() {
  const base = setupBase();
  const uow = fakeStatementUnitOfWork(base.ledger, base.masters);
  const deps = { uow, ids: base.ids, clock: base.clock };
  return { ...base, uow, deps, bank: base.accountId("普通預金"), cash: base.accountId("現金") };
}
type Ctx = ReturnType<typeof setup>;

const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  accountName: "サンプル銀行",
  date: "2026-05-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});
/** 行から取込の入力（表のテキストと列の対応）を作る */
const paste = (rows: StatementRow[], sha256 = SHA) => ({
  ...statementTableOf(rows),
  origin: "paste" as const,
  sha256,
});

const mapAccount = (ctx: Ctx, name: string, over: Record<string, unknown> = {}) => {
  const r = saveStatementAccount(ctx.deps, name, {
    usage: "business",
    kind: "bank",
    accountId: ctx.bank,
    ...over,
  } as never);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const expectErr = (r: Result<unknown>, code: string) => {
  if (r.ok) throw new Error("失敗するはず");
  expect(r.error.code).toBe(code);
  return r.error;
};

let ctx: Ctx;
beforeEach(() => {
  ctx = setup();
});

describe("saveStatementAccount / listStatementAccounts", () => {
  it("名前で追加し、一覧は名前順。rebuilt は 0（候補の作り直しは US2）", () => {
    const saved = mapAccount(ctx, "テストカードA", { kind: "card", usage: "mixed" });
    expect(saved.rebuilt).toBe(0);
    expect(saved.account).toMatchObject({ name: "テストカードA", usage: "mixed", kind: "card" });
    mapAccount(ctx, "サンプル銀行");
    const list = listStatementAccounts(ctx.deps);
    expect(list.ok && list.value.map((a) => a.name)).toEqual(["サンプル銀行", "テストカードA"]);
  });

  it("同じ名前の保存は更新（ID・作成日時を保つ）。変更は監査に残る", () => {
    const first = mapAccount(ctx, "サンプル銀行");
    const updated = mapAccount(ctx, "サンプル銀行", { usage: "mixed", accountId: ctx.cash });
    expect(updated.account.id).toBe(first.account.id);
    expect(updated.account.createdAt).toBe(first.account.createdAt);
    expect(updated.account).toMatchObject({ usage: "mixed", accountId: ctx.cash });
    const audits = ctx.uow.statements.audits;
    expect(audits.map((a) => [a.targetType, a.action, a.targetId])).toEqual([
      ["statement_account", "create", first.account.id],
      ["statement_account", "update", first.account.id],
    ]);
    expect(JSON.parse(audits[1]?.beforeJson ?? "{}")).toMatchObject({ usage: "business" });
    expect(JSON.parse(audits[1]?.afterJson ?? "{}")).toMatchObject({ usage: "mixed" });
  });

  it("変更がなければ書かない（監査も増えない）", () => {
    mapAccount(ctx, "サンプル銀行");
    mapAccount(ctx, "サンプル銀行");
    expect(ctx.uow.statements.audits).toHaveLength(1);
  });

  it("private は科目を持たない。ほかは科目が必須（VALIDATION）", () => {
    const priv = mapAccount(ctx, "テスト現金", { usage: "private", accountId: undefined });
    expect(priv.account).toMatchObject({ accountId: null, subAccountId: null });
    expectErr(
      saveStatementAccount(ctx.deps, "A", { usage: "private", kind: "bank", accountId: ctx.bank }),
      "VALIDATION",
    );
    expectErr(
      saveStatementAccount(ctx.deps, "A", { usage: "business", kind: "bank" }),
      "VALIDATION",
    );
  });

  it("科目がない・使用停止なら ACCOUNT_NOT_FOUND・ACCOUNT_INACTIVE、補助科目が別の科目のものなら VALIDATION", () => {
    expectErr(
      saveStatementAccount(ctx.deps, "A", { usage: "business", kind: "bank", accountId: "nope" }),
      "ACCOUNT_NOT_FOUND",
    );
    expectErr(
      saveStatementAccount(ctx.deps, "A", {
        usage: "business",
        kind: "bank",
        accountId: ctx.cash,
        subAccountId: "nope",
      }),
      "VALIDATION",
    );
    const account = ctx.masters.getAccount(ctx.bank);
    if (account === undefined) throw new Error("科目がない");
    ctx.masters.updateAccount({ ...account, isActive: false });
    expectErr(
      saveStatementAccount(ctx.deps, "A", { usage: "business", kind: "bank", accountId: ctx.bank }),
      "ACCOUNT_INACTIVE",
    );
  });

  it("名前が空なら VALIDATION", () => {
    expectErr(
      saveStatementAccount(ctx.deps, "  ", {
        usage: "business",
        kind: "bank",
        accountId: ctx.bank,
      }),
      "VALIDATION",
    );
  });
});

describe("detectStatementLayout（007 H:§2.1）", () => {
  it("区切り文字・見出しの行・列の案・年の要否を返す（何も書かない）", () => {
    const text = readStatementText(MFME_PASTE.file);
    const r = detectStatementLayout(ctx.deps, text);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toMatchObject({
      delimiter: "\t",
      headerRow: 0,
      columnCount: 10,
      rowCount: MFME_PASTE.rowCount,
      needsYear: true,
      suggestedColumns: MFME_PASTE.mapping.columns,
    });
    expect(r.value.sampleRows).toHaveLength(10);
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("選び直し（見出しなし）を渡せる。表がなければ STATEMENT_TABLE_UNREADABLE", () => {
    const text = readStatementText(MFME_PASTE.file);
    const r = detectStatementLayout(ctx.deps, text, { headerRow: null });
    expect(r.ok && r.value.headerRow).toBeNull();
    expectErr(detectStatementLayout(ctx.deps, "\n \n"), "STATEMENT_TABLE_UNREADABLE");
  });
});

describe("previewStatementImport", () => {
  const fixtureInput = (over: Record<string, unknown> = {}) => ({
    text: readStatementText(MFME_PASTE.file),
    origin: "paste" as const,
    year: MFME_PASTE.year ?? 2026,
    mapping: MFME_PASTE.mapping,
    sha256: SHA,
    ...over,
  });

  it("件数・期間・合計・未対応の口座・読めない行を返し、何も書かない", () => {
    mapAccount(ctx, "サンプル銀行");
    const r = previewStatementImport(ctx.deps, fixtureInput());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const p = r.value;
    expect(p.inputSha256).toBe(SHA);
    expect(p.countNew).toBe(MFME_PASTE.rowCount);
    expect(p.rows).toHaveLength(MFME_PASTE.rowCount);
    expect(p.period).toEqual({ from: "2026-10-01", to: "2026-10-12" });
    expect(p.totals).toEqual({ inflow: MFME_PASTE.inflowTotal, outflow: MFME_PASTE.outflowTotal });
    expect(p.unmappedAccounts).toEqual([
      { name: "テストカードA", suggestion: null },
      { name: "テスト現金", suggestion: null },
    ]);
    expect(p.unreadable).toEqual([]);
    expect(p.rows[0]).toMatchObject({
      key: "サンプル銀行|2026-10-01|-1200|ショップ#|0",
      status: "new",
      accountName: "サンプル銀行",
      warnings: [],
    });
    expect(ctx.uow.statements.state.statements).toEqual([]);
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("読めない行は unreadable に理由つきで返す（明細に加えない）", () => {
    const table = statementTableOf([row()]);
    const r = previewStatementImport(ctx.deps, {
      ...paste([row()]),
      text: `${table.text}小計\t\t\t\n`,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.countNew).toBe(1);
    expect(r.value.unreadable).toEqual([{ line: 3, reason: expect.stringContaining("日付") }]);
  });

  it("1 行も読めない表は STATEMENT_TABLE_UNREADABLE（details.unreadable）", () => {
    const r = previewStatementImport(ctx.deps, {
      ...paste([row()]),
      text: `${statementTableOf([row()]).text.split("\n")[0]}\nあ\tい\tう\tえ\tお\tか\tき\tく\tけ\n`,
    });
    const e = expectErr(r, "STATEMENT_TABLE_UNREADABLE");
    expect(e.details?.unreadable).toEqual([{ line: 2, reason: expect.stringContaining("日付") }]);
  });

  it("列の番号が表の列数を超えれば STATEMENT_MAPPING_INVALID", () => {
    const input = paste([row()]);
    const r = previewStatementImport(ctx.deps, {
      ...input,
      mapping: { ...input.mapping, columns: { ...input.mapping.columns, memo: 20 } },
    });
    expectErr(r, "STATEMENT_MAPPING_INVALID");
  });

  it("accountName の役割がなく fixedAccountName もなければ STATEMENT_MAPPING_INVALID（INV-50）", () => {
    const input = paste([row()]);
    const { accountName: _omit, ...columns } = input.mapping.columns;
    const noAccount = { ...input, mapping: { ...input.mapping, columns } };
    expectErr(previewStatementImport(ctx.deps, noAccount), "STATEMENT_MAPPING_INVALID");
    expectErr(
      previewStatementImport(ctx.deps, { ...noAccount, fixedAccountName: "  " }),
      "STATEMENT_MAPPING_INVALID",
    );
  });

  it("fixedAccountName があれば、全行の口座がその名前になる", () => {
    const input = paste([row({ accountName: "別の名前" }), row({ date: "2026-05-11" })]);
    const { accountName: _omit, ...columns } = input.mapping.columns;
    const r = previewStatementImport(ctx.deps, {
      ...input,
      mapping: { ...input.mapping, columns },
      fixedAccountName: "テスト現金",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.rows.map((x) => x.accountName)).toEqual(["テスト現金", "テスト現金"]);
    expect(r.value.unmappedAccounts).toEqual([{ name: "テスト現金", suggestion: null }]);
  });
});

describe("commitStatementImport", () => {
  const rows = [row(), row({ amount: 3000, content: "売上入金" }), row({ date: "2026-05-11" })];
  const commitInput = (
    over: { rows?: StatementRow[]; sha?: string; expectedSha?: string; countNew?: number } = {},
  ) => ({
    ...paste(over.rows ?? rows, over.sha ?? SHA),
    expected: { inputSha256: over.expectedSha ?? SHA, countNew: over.countNew ?? 3 },
  });

  it("回と明細を書く。口座は名前で結びつき、明細は元の内容と正規化した内容を持つ", () => {
    const account = mapAccount(ctx, "サンプル銀行").account;
    const r = commitStatementImport(ctx.deps, commitInput());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.added).toBe(3);
    expect(r.value.changed).toBe(0);
    expect(r.value.batch).toMatchObject({
      origin: "paste",
      inputSha256: SHA,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 3,
      countExisting: 0,
      countUnreadable: 0,
    });
    const stored = ctx.uow.statements.state.statements;
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({
      batchId: r.value.batch.id,
      statementAccountId: account.id,
      stableKey: "サンプル銀行|2026-05-10|-1200|ショップ#|0",
      externalId: null,
      amount: -1200,
      content: "ショップ001",
      normalizedContent: "ショップ#",
      transferFlag: false,
      changedJson: null,
      excludedAt: null,
    });
  });

  it("取込の回を監査に残す", () => {
    mapAccount(ctx, "サンプル銀行");
    const before = ctx.uow.statements.audits.length;
    const r = commitStatementImport(ctx.deps, commitInput());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const added = ctx.uow.statements.audits.slice(before);
    expect(added.map((a) => [a.targetType, a.action, a.targetId])).toEqual([
      ["statement_batch", "create", r.value.batch.id],
    ]);
  });

  it("同じ入力の再取込は新規 0 件（INV-40）。回は 0 件でも記録する", () => {
    mapAccount(ctx, "サンプル銀行");
    commitStatementImport(ctx.deps, commitInput());
    const preview = previewStatementImport(ctx.deps, paste(rows));
    expect(preview.ok && preview.value.countNew).toBe(0);
    const again = commitStatementImport(ctx.deps, commitInput({ countNew: 0 }));
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect(again.value.added).toBe(0);
    expect(again.value.batch).toMatchObject({ countNew: 0, countExisting: 3 });
    expect(ctx.uow.statements.state.statements).toHaveLength(3);
  });

  it("未対応の口座があれば STATEMENT_ACCOUNT_UNMAPPED（details.names）で、何も書かない", () => {
    mapAccount(ctx, "サンプル銀行");
    const e = expectErr(
      commitStatementImport(
        ctx.deps,
        commitInput({ rows: [...rows, row({ accountName: "テストカードA" })], countNew: 4 }),
      ),
      "STATEMENT_ACCOUNT_UNMAPPED",
    );
    expect(e.details?.names).toEqual(["テストカードA"]);
    expect(ctx.uow.statements.state.statements).toEqual([]);
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("入力のハッシュがプレビューと違えば STATEMENT_PLAN_CHANGED", () => {
    mapAccount(ctx, "サンプル銀行");
    expectErr(
      commitStatementImport(ctx.deps, commitInput({ sha: SHA2 })),
      "STATEMENT_PLAN_CHANGED",
    );
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("新規の件数がプレビューと違えば STATEMENT_PLAN_CHANGED", () => {
    mapAccount(ctx, "サンプル銀行");
    const e = expectErr(
      commitStatementImport(ctx.deps, commitInput({ countNew: 2 })),
      "STATEMENT_PLAN_CHANGED",
    );
    expect(e.details).toMatchObject({ expected: 2, actual: 3 });
    expect(ctx.uow.statements.state.statements).toEqual([]);
  });

  it("取込の回の origin は入力の値（file も書ける）。読めない行の数を回に残す", () => {
    mapAccount(ctx, "サンプル銀行");
    const input = commitInput();
    const r = commitStatementImport(ctx.deps, {
      ...input,
      origin: "file",
      text: `${input.text}小計\t\t\t\n`,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.batch).toMatchObject({ origin: "file", countNew: 3, countUnreadable: 1 });
  });

  it("列の対応が表に合わなければ STATEMENT_MAPPING_INVALID で、何も書かない（INV-50 の前半も）", () => {
    mapAccount(ctx, "サンプル銀行");
    const input = commitInput();
    const tooWide = {
      ...input,
      mapping: { ...input.mapping, columns: { ...input.mapping.columns, memo: 20 } },
    };
    expectErr(commitStatementImport(ctx.deps, tooWide), "STATEMENT_MAPPING_INVALID");
    const { accountName: _omit, ...columns } = input.mapping.columns;
    const noAccount = { ...input, mapping: { ...input.mapping, columns } };
    expectErr(commitStatementImport(ctx.deps, noAccount), "STATEMENT_MAPPING_INVALID");
    expect(ctx.uow.statements.state.batches).toEqual([]);
    expect(ctx.uow.statements.state.statements).toEqual([]);
  });

  it("fixedAccountName の取込は、その口座の対応で確定する", () => {
    const account = mapAccount(ctx, "テスト現金", { kind: "cash" }).account;
    const input = commitInput({ rows: [row({ accountName: "無視される名前" })], countNew: 1 });
    const { accountName: _omit, ...columns } = input.mapping.columns;
    const r = commitStatementImport(ctx.deps, {
      ...input,
      mapping: { ...input.mapping, columns },
      fixedAccountName: "テスト現金",
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(ctx.uow.statements.state.statements[0]).toMatchObject({
      statementAccountId: account.id,
    });
  });

  it("途中で失敗すると、回も明細も残らない（INV-47 の取込の側）", () => {
    mapAccount(ctx, "サンプル銀行");
    ctx.uow.statements.failOnInsertStatements = true;
    expect(() => commitStatementImport(ctx.deps, commitInput())).toThrow();
    expect(ctx.uow.statements.state.batches).toEqual([]);
    expect(ctx.uow.statements.state.statements).toEqual([]);
  });
});

describe("commitStatementRows（external_id を持つ行。ID の列がある表）", () => {
  const original = row({ externalId: "ext-1", memo: "最初のメモ" });
  const setupStored = () => {
    mapAccount(ctx, "サンプル銀行");
    const first = commitStatementRows(ctx.deps, {
      origin: "file",
      rows: [original],
      unreadable: [],
      sha256: SHA,
      expected: { inputSha256: SHA, countNew: 1 },
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    return first.value;
  };

  it("内容が違う行は changed_json に新しい内容を書き、changed_ack_at を NULL に戻す。監査にも残る", () => {
    setupStored();
    const stored = ctx.uow.statements;
    const target = stored.state.statements[0];
    if (target === undefined) throw new Error("明細がない");
    target.changedAckAt = "2026-10-26T00:00:00.000Z"; // 利用者が前の変更を確認した状態
    const edited = row({ externalId: "ext-1", memo: "直したメモ" });
    const r = commitStatementRows(ctx.deps, {
      origin: "file",
      rows: [edited],
      unreadable: [],
      sha256: SHA2,
      expected: { inputSha256: SHA2, countNew: 0 },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value).toMatchObject({ added: 0, changed: 1 });
    expect(r.value.batch).toMatchObject({ countNew: 0, countExisting: 0 });
    expect(stored.state.statements).toHaveLength(1);
    expect(stored.state.statements[0]?.changedAckAt).toBeNull();
    expect(JSON.parse(stored.state.statements[0]?.changedJson ?? "{}")).toMatchObject({
      memo: "直したメモ",
      amount: -1200,
    });
    const update = stored.audits.find((a) => a.targetType === "statement" && a.action === "update");
    expect(update?.targetId).toBe(target.id);
    expect(JSON.parse(update?.beforeJson ?? "{}")).toMatchObject({ memo: "最初のメモ" });
    expect(JSON.parse(update?.afterJson ?? "{}")).toMatchObject({ memo: "直したメモ" });
  });

  it("changed の行のプレビューは変更前後を持ち、新規の件数に数えない", () => {
    setupStored();
    const edited = row({ externalId: "ext-1", memo: "直したメモ" });
    const r = previewStatementRows(ctx.deps, {
      origin: "file",
      rows: [edited],
      unreadable: [],
      sha256: SHA2,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.countNew).toBe(0);
    expect(r.value.rows[0]).toMatchObject({
      status: "changed",
      changed: { before: { memo: "最初のメモ" }, after: { memo: "直したメモ" } },
    });
  });

  it("貼り付け（external_id なし）は、キーが同じなら内容が違っても existing", () => {
    setupStored();
    const r = previewStatementImport(ctx.deps, paste([row({ memo: "別のメモ" })], SHA2));
    expect(r.ok && r.value.rows[0]?.status).toBe("existing");
  });
});

describe("listStatementBatches", () => {
  it("新しい順", () => {
    mapAccount(ctx, "サンプル銀行");
    const first = commitStatementImport(ctx.deps, {
      ...paste([row()]),
      expected: { inputSha256: SHA, countNew: 1 },
    });
    ctx.clock.value = "2026-11-01T00:00:00.000Z";
    const second = commitStatementImport(ctx.deps, {
      ...paste([row({ amount: -5 })], SHA2),
      expected: { inputSha256: SHA2, countNew: 1 },
    });
    if (!first.ok || !second.ok) throw new Error("確定に失敗");
    const list = listStatementBatches(ctx.deps);
    expect(list.ok && list.value.map((b) => b.id)).toEqual([
      second.value.batch.id,
      first.value.batch.id,
    ]);
  });
});
