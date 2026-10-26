import { beforeEach, describe, expect, it } from "vitest";
import type { PastedRow } from "../../src/statements/paste.ts";
import type { Result } from "../../src/types.ts";
import {
  commitStatementImport,
  commitStatementRows,
  listStatementAccounts,
  listStatementBatches,
  previewStatementImport,
  previewStatementRows,
  saveStatementAccount,
} from "../../src/usecases/statements.ts";
import { fakeStatementUnitOfWork } from "../fakes.ts";
import { readTextFixture } from "../fixtures/mfme/load.ts";
import { setupBase } from "../ledger-setup.ts";
import { formatMfmePaste } from "../statements-arbitraries.ts";

// 006 T009（R4・R14・R18、§1.1〜§1.3、FR-002〜007）。口座の対応・取込のプレビューと確定

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function setup() {
  const base = setupBase();
  const uow = fakeStatementUnitOfWork(base.ledger, base.masters);
  const deps = { uow, ids: base.ids, clock: base.clock };
  return { ...base, uow, deps, bank: base.accountId("普通預金"), cash: base.accountId("現金") };
}
type Ctx = ReturnType<typeof setup>;

const row = (over: Partial<PastedRow> = {}): PastedRow => ({
  accountName: "サンプル銀行",
  date: "2026-05-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});
const paste = (rows: PastedRow[]) => ({
  kind: "paste" as const,
  text: formatMfmePaste(rows),
  year: 2026,
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

describe("previewStatementImport", () => {
  it("件数・期間・合計・未対応の口座・読めない行を返し、何も書かない", () => {
    mapAccount(ctx, "サンプル銀行");
    const text = readTextFixture("paste-basic.txt");
    const r = previewStatementImport(ctx.deps, {
      source: { kind: "paste", text, year: 2026 },
      sha256: SHA,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const p = r.value;
    expect(p.inputSha256).toBe(SHA);
    expect(p.countNew).toBe(9);
    expect(p.rows).toHaveLength(9);
    expect(p.period).toEqual({ from: "2026-10-01", to: "2026-10-08" });
    expect(p.totals).toEqual({
      inflow: 330_000 + 1_500 + 45_000 + 20_000,
      outflow: 1_200 + 45_000 + 20_000 + 3_980 * 2,
    });
    expect(p.unmappedAccounts).toEqual(["テストカードA", "テスト現金"]);
    expect(p.unreadable).toEqual([{ line: 11, reason: expect.stringContaining("日付") }]);
    expect(p.rows[0]).toMatchObject({
      key: "サンプル銀行|2026-10-01|-1200|ショップ#|0",
      status: "new",
      accountName: "サンプル銀行",
      warnings: [],
    });
    expect(ctx.uow.statements.state.statements).toEqual([]);
    expect(ctx.uow.statements.state.batches).toEqual([]);
  });

  it("読めない貼り付けは STATEMENT_PASTE_UNREADABLE", () => {
    const r = previewStatementImport(ctx.deps, {
      source: { kind: "paste", text: "あいうえお", year: 2026 },
      sha256: SHA,
    });
    expectErr(r, "STATEMENT_PASTE_UNREADABLE");
  });
});

describe("commitStatementImport", () => {
  const rows = [row(), row({ amount: 3000, content: "売上入金" }), row({ date: "2026-05-11" })];
  const commitInput = (
    over: { rows?: PastedRow[]; sha?: string; expectedSha?: string; countNew?: number } = {},
  ) => ({
    source: paste(over.rows ?? rows),
    sha256: over.sha ?? SHA,
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
    const preview = previewStatementImport(ctx.deps, { source: paste(rows), sha256: SHA });
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

  it("途中で失敗すると、回も明細も残らない（INV-47 の取込の側）", () => {
    mapAccount(ctx, "サンプル銀行");
    ctx.uow.statements.failOnInsertStatements = true;
    expect(() => commitStatementImport(ctx.deps, commitInput())).toThrow();
    expect(ctx.uow.statements.state.batches).toEqual([]);
    expect(ctx.uow.statements.state.statements).toEqual([]);
  });
});

describe("commitStatementRows（external_id を持つ行。自動取得 US4 も使う）", () => {
  const original = row({ externalId: "ext-1", memo: "最初のメモ" });
  const setupStored = () => {
    mapAccount(ctx, "サンプル銀行");
    const first = commitStatementRows(ctx.deps, {
      origin: "mfme_fetch",
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
      origin: "mfme_fetch",
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
      origin: "mfme_fetch",
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
    const r = previewStatementImport(ctx.deps, {
      source: paste([row({ memo: "別のメモ" })]),
      sha256: SHA2,
    });
    expect(r.ok && r.value.rows[0]?.status).toBe("existing");
  });
});

describe("listStatementBatches", () => {
  it("新しい順", () => {
    mapAccount(ctx, "サンプル銀行");
    const first = commitStatementImport(ctx.deps, {
      source: paste([row()]),
      sha256: SHA,
      expected: { inputSha256: SHA, countNew: 1 },
    });
    ctx.clock.value = "2026-11-01T00:00:00.000Z";
    const second = commitStatementImport(ctx.deps, {
      source: paste([row({ amount: -5 })]),
      sha256: SHA2,
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
