import type { StatementAccountInput } from "@trebuchet/schema";
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
import { MFME_PASTE } from "../fixtures/statements/expected.ts";
import { readStatementText } from "../fixtures/statements/load.ts";
import { statementTableOf } from "../statements-arbitraries.ts";
import { type StatementsCtx, setupStatements } from "../statements-setup.ts";

// 006 T009（R4・R14・R18、§1.1〜§1.3、FR-002〜007）・007 T008（H:§2.1〜2.3）。
// 口座の対応・表の判定・取込のプレビューと確定

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

type Ctx = StatementsCtx;

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
    accountId: ctx.a.bank,
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
  ctx = setupStatements();
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
    const updated = mapAccount(ctx, "サンプル銀行", { usage: "mixed", accountId: ctx.a.cash });
    expect(updated.account.id).toBe(first.account.id);
    expect(updated.account.createdAt).toBe(first.account.createdAt);
    expect(updated.account).toMatchObject({ usage: "mixed", accountId: ctx.a.cash });
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
      saveStatementAccount(ctx.deps, "A", {
        usage: "private",
        kind: "bank",
        accountId: ctx.a.bank,
      }),
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
        accountId: ctx.a.cash,
        subAccountId: "nope",
      }),
      "VALIDATION",
    );
    const account = ctx.masters.getAccount(ctx.a.bank);
    if (account === undefined) throw new Error("科目がない");
    ctx.masters.updateAccount({ ...account, isActive: false });
    expectErr(
      saveStatementAccount(ctx.deps, "A", {
        usage: "business",
        kind: "bank",
        accountId: ctx.a.bank,
      }),
      "ACCOUNT_INACTIVE",
    );
  });

  it("名前が空なら VALIDATION", () => {
    expectErr(
      saveStatementAccount(ctx.deps, "  ", {
        usage: "business",
        kind: "bank",
        accountId: ctx.a.bank,
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
    // 推定の案（007 R9）: 名前の手がかりから種類・科目。用途は名前に手がかりがないので null
    expect(p.unmappedAccounts).toEqual([
      {
        name: "テストカードA",
        suggestion: {
          kind: "card",
          accountId: ctx.accountId("未払金"),
          subAccountId: null,
          usage: null,
          cues: ["カード"],
        },
      },
      {
        name: "テスト現金",
        suggestion: {
          kind: "cash",
          accountId: ctx.a.cash,
          subAccountId: null,
          usage: null,
          cues: ["現金"],
        },
      },
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
    expect(r.value.unmappedAccounts).toMatchObject([
      { name: "テスト現金", suggestion: { kind: "cash", cues: ["現金"] } },
    ]);
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

// 007 T014（R9、FR-014、US3-4）: 未対応の口座の対応を、取込と同じ UnitOfWork で保存する
describe("commitStatementImport の accounts（未対応の口座の対応）", () => {
  const rows = [
    row(),
    row({ accountName: "テストカードA", content: "ショップ002" }),
    row({ accountName: "テストカードA", date: "2026-05-11" }),
  ];
  const bankInput = (ctx: Ctx) => ({
    name: "サンプル銀行",
    input: { usage: "business", kind: "bank", accountId: ctx.a.bank } as const,
  });
  const cardInput = (ctx: Ctx) => ({
    name: "テストカードA",
    input: {
      usage: "mixed",
      kind: "card",
      accountId: ctx.accountId("未払金"),
    } as const,
  });
  const commit = (
    accounts: { name: string; input: StatementAccountInput }[] | undefined,
    countNew = 3,
  ) =>
    commitStatementImport(ctx.deps, {
      ...paste(rows),
      expected: { inputSha256: SHA, countNew },
      ...(accounts === undefined ? {} : { accounts }),
    });
  const expectNothingWritten = () => {
    const s = ctx.uow.statements;
    expect(s.state.accounts).toEqual([]);
    expect(s.state.batches).toEqual([]);
    expect(s.state.statements).toEqual([]);
    expect(s.audits).toEqual([]);
  };

  it("口座の対応を保存してから明細を書く。口座は保存した対応に結びつき、監査は口座 → 回の順", () => {
    const r = commit([bankInput(ctx), cardInput(ctx)]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.added).toBe(3);
    const accounts = listStatementAccounts(ctx.deps);
    if (!accounts.ok) throw new Error("一覧に失敗");
    expect(accounts.value.map((a) => [a.name, a.usage, a.kind, a.accountId])).toEqual([
      ["サンプル銀行", "business", "bank", ctx.a.bank],
      ["テストカードA", "mixed", "card", ctx.accountId("未払金")],
    ]);
    const idOf = new Map(accounts.value.map((a) => [a.name, a.id]));
    expect(ctx.uow.statements.state.statements.map((s) => s.statementAccountId).sort()).toEqual(
      [idOf.get("サンプル銀行"), idOf.get("テストカードA"), idOf.get("テストカードA")].sort(),
    );
    expect(ctx.uow.statements.audits.map((a) => [a.targetType, a.action]).slice(0, 3)).toEqual([
      ["statement_account", "create"],
      ["statement_account", "create"],
      ["statement_batch", "create"],
    ]);
    // 取込の後は、対応済みなので accounts なしで同じ取込ができる（新規 0 件）
    expect(commit(undefined, 0).ok).toBe(true);
  });

  it("private の口座は科目なしで保存できる", () => {
    const r = commit([
      bankInput(ctx),
      { name: "テストカードA", input: { usage: "private", kind: "card" } },
    ]);
    expect(r.ok).toBe(true);
    const a = ctx.uow.statements.state.accounts.find((x) => x.name === "テストカードA");
    expect(a).toMatchObject({ usage: "private", accountId: null });
  });

  it("accounts にない未対応の口座は STATEMENT_ACCOUNT_UNMAPPED（残りの名前だけ）で、何も書かない", () => {
    const e = expectErr(commit([bankInput(ctx)]), "STATEMENT_ACCOUNT_UNMAPPED");
    expect(e.details?.names).toEqual(["テストカードA"]);
    expectNothingWritten();
    expectErr(commit(undefined), "STATEMENT_ACCOUNT_UNMAPPED");
    expectNothingWritten();
  });

  it("対応のある口座の名前が入っていれば VALIDATION（上書きしない）", () => {
    mapAccount(ctx, "サンプル銀行");
    const before = structuredClone(ctx.uow.statements.state.accounts);
    const auditsBefore = ctx.uow.statements.audits.length;
    const e = expectErr(
      commit([{ name: "サンプル銀行", input: { usage: "private", kind: "bank" } }, cardInput(ctx)]),
      "VALIDATION",
    );
    expect(e.details?.names).toEqual(["サンプル銀行"]);
    expect(ctx.uow.statements.state.accounts).toEqual(before);
    expect(ctx.uow.statements.audits).toHaveLength(auditsBefore);
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("取込の行にない名前・同じ名前が 2 回あれば VALIDATION で、何も書かない", () => {
    expectErr(
      commit([bankInput(ctx), cardInput(ctx), { ...bankInput(ctx), name: "どこにもない口座" }]),
      "VALIDATION",
    );
    expectNothingWritten();
    expectErr(commit([bankInput(ctx), bankInput(ctx), cardInput(ctx)]), "VALIDATION");
    expectNothingWritten();
  });

  it("口座の対応のうち 1 つが科目の検査で落ちれば、先に保存した口座も回も明細も残らない", () => {
    const bad = { name: "テストカードA", input: { ...cardInput(ctx).input, accountId: "nope" } };
    const e = expectErr(commit([bankInput(ctx), bad]), "ACCOUNT_NOT_FOUND");
    expect(e.details?.accountId).toBe("nope");
    expectNothingWritten();

    const account = ctx.masters.getAccount(ctx.accountId("未払金"));
    if (account === undefined) throw new Error("科目がない");
    ctx.masters.updateAccount({ ...account, isActive: false });
    expectErr(commit([bankInput(ctx), cardInput(ctx)]), "ACCOUNT_INACTIVE");
    expectNothingWritten();

    ctx.masters.updateAccount({ ...account, isActive: true });
    const wrongSub = {
      name: "テストカードA",
      input: { ...cardInput(ctx).input, subAccountId: "nope" },
    };
    expectErr(commit([bankInput(ctx), wrongSub]), "VALIDATION");
    expectNothingWritten();
  });

  it("入力の形（private に科目、科目なしの business、空の名前）も VALIDATION で、何も書かない", () => {
    expectErr(
      commit([
        bankInput(ctx),
        { name: "テストカードA", input: { usage: "private", kind: "card", accountId: ctx.a.bank } },
      ]),
      "VALIDATION",
    );
    expectErr(
      commit([
        bankInput(ctx),
        { name: "テストカードA", input: { usage: "business", kind: "card" } },
      ]),
      "VALIDATION",
    );
    expectNothingWritten();
  });

  it("明細の書き込みが途中で失敗（例外）しても、口座の対応は残らない（全部か無か）", () => {
    ctx.uow.statements.failOnInsertStatements = true;
    expect(() => commit([bankInput(ctx), cardInput(ctx)])).toThrow();
    expectNothingWritten();
  });

  it("新規の件数がプレビューと違えば STATEMENT_PLAN_CHANGED で、口座の対応も残らない", () => {
    expectErr(commit([bankInput(ctx), cardInput(ctx)], 99), "STATEMENT_PLAN_CHANGED");
    expectNothingWritten();
  });
});

describe("previewStatementImport の口座の案（007 R9）", () => {
  it("大項目だけが手がかりの口座は「大項目: <名前>」。決まらない口座は null。何も保存しない", () => {
    const r = previewStatementImport(
      ctx.deps,
      paste([
        row({ accountName: "テスト口座1", categoryMajor: "クレジットカード" }),
        row({ accountName: "テスト口座2", categoryMajor: "食費" }),
        row({ accountName: "テストカード（事業用）" }),
      ]),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const byName = new Map(r.value.unmappedAccounts.map((u) => [u.name, u.suggestion]));
    expect(byName.get("テスト口座1")).toMatchObject({
      kind: "card",
      cues: ["大項目: クレジットカード"],
    });
    expect(byName.get("テスト口座2")).toBeNull();
    expect(byName.get("テストカード（事業用）")).toMatchObject({ kind: "card", usage: "business" });
    expect(ctx.uow.statements.state.accounts).toEqual([]);
    expect(ctx.uow.statements.audits).toEqual([]);
  });

  it("同じ名前の補助科目が 1 つだけあれば、補助科目も案にする", () => {
    const card = ctx.accountId("未払金");
    ctx.masters.insertSubAccount({
      id: "sub-1",
      accountId: card,
      name: "テストカードA",
      isActive: true,
    });
    const r = previewStatementImport(ctx.deps, paste([row({ accountName: "テストカードA" })]));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.unmappedAccounts[0]?.suggestion).toMatchObject({ subAccountId: "sub-1" });
  });
});
