import type { StatementColumnMapping } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { headerSignature } from "../../src/statements/sources.ts";
import {
  commitStatementImport,
  previewStatementImport,
  saveStatementAccount,
} from "../../src/usecases/statements.ts";
import { fakeStatementUnitOfWork } from "../fakes.ts";
import { BANK_TWO_COLUMNS } from "../fixtures/statements/expected.ts";
import { readStatementText } from "../fixtures/statements/load.ts";
import { setupBase } from "../ledger-setup.ts";
import { codeOf, unwrap } from "../result.ts";
import { FaultInjectingStatementUnitOfWork, snapshotOf } from "../statement-fault-injection.ts";
import { statementTableOf } from "../statements-arbitraries.ts";

// 007 T012（R7、INV-47 の拡張・INV-50）: 取込の確定と取込元の保存は同じ UnitOfWork

const SHA = "a".repeat(64);
const BANK_MAPPING: StatementColumnMapping = {
  delimiter: ",",
  headerRow: 3,
  columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
};
const BANK_HEADER = ["取引日", "摘要", "出金額", "入金額", "残高"];

function setup() {
  const base = setupBase();
  const inner = fakeStatementUnitOfWork(base.ledger, base.masters);
  const injector = new FaultInjectingStatementUnitOfWork(inner);
  const deps = { uow: injector, ids: base.ids, clock: base.clock };
  const accounts = (name: string) => {
    const r = saveStatementAccount(deps, name, {
      usage: "business",
      kind: "bank",
      accountId: base.accountId("普通預金"),
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  accounts("サンプル銀行");
  return {
    ...base,
    inner,
    injector,
    deps,
    // 巻き戻しは state を差し替えるので、そのつど読む
    get state() {
      return inner.statements.state;
    },
  };
}
type Ctx = ReturnType<typeof setup>;

/** 1 つの口座の取込元（銀行の CSV。fixedAccountName） */
const bankInput = (over: Record<string, unknown> = {}) => ({
  text: readStatementText("bank-two-columns.utf8.csv"),
  origin: "file" as const,
  year: 2026,
  mapping: BANK_MAPPING,
  fixedAccountName: "サンプル銀行",
  sha256: SHA,
  ...over,
});

const commit = (
  ctx: Ctx,
  saveSource: { id?: string; name: string } | null,
  over: Record<string, unknown> = {},
) => {
  const input = bankInput(over);
  const preview = previewStatementImport(ctx.deps, input);
  if (!preview.ok) throw new Error(JSON.stringify(preview.error));
  return commitStatementImport(ctx.deps, {
    ...input,
    expected: { inputSha256: input.sha256, countNew: preview.value.countNew },
    saveSource,
  });
};

describe("commitStatementImport の saveSource", () => {
  it("null なら取込元を保存しない（回の sourceName は null、応答の source は null）", () => {
    const ctx = setup();
    const r = unwrap(commit(ctx, null));
    expect(r.source).toBeNull();
    expect(r.batch.sourceName).toBeNull();
    expect(ctx.state.sources).toEqual([]);
  });

  it("省略でも保存しない", () => {
    const ctx = setup();
    const input = bankInput();
    const r = unwrap(
      commitStatementImport(ctx.deps, {
        ...input,
        expected: { inputSha256: SHA, countNew: BANK_TWO_COLUMNS.rowCount },
      }),
    );
    expect(r.source).toBeNull();
    expect(ctx.state.sources).toEqual([]);
  });

  it("1 つの口座の取込元: 新しく作る。対応・見出しの署名・口座名・last_used_at・回の sourceName・監査", () => {
    const ctx = setup();
    const r = unwrap(commit(ctx, { name: "  サンプル銀行の普通預金  " }));
    expect(r.source).toMatchObject({
      name: "サンプル銀行の普通預金",
      fixedAccountName: "サンプル銀行",
      mapping: BANK_MAPPING,
      header: headerSignature(BANK_HEADER),
      lastUsedAt: ctx.clock.now(),
      createdAt: ctx.clock.now(),
      updatedAt: ctx.clock.now(),
    });
    expect(ctx.state.sources).toEqual([r.source]);
    expect(r.batch.sourceName).toBe("サンプル銀行の普通預金");
    expect(ctx.state.batches[0]?.sourceName).toBe("サンプル銀行の普通預金");
    const audit = ctx.state.audits.find((a) => a.targetType === "statement_source");
    expect(audit).toMatchObject({ targetId: r.source?.id, action: "create", beforeJson: null });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({
      name: "サンプル銀行の普通預金",
    });
  });

  it("まとめの取込元（accountName の列がある対応）は fixed_account_name が NULL（INV-50）。fixedAccountName を渡しても入れない", () => {
    const ctx = setup();
    const table = statementTableOf([
      {
        accountName: "サンプル銀行",
        date: "2026-05-10",
        content: "ショップ001",
        amount: -1200,
        transferFlag: false,
      },
    ]);
    const input = {
      ...table,
      origin: "paste" as const,
      sha256: SHA,
      fixedAccountName: "余計な名前",
    };
    const r = unwrap(
      commitStatementImport(ctx.deps, {
        ...input,
        expected: { inputSha256: SHA, countNew: 1 },
        saveSource: { name: "まとめ" },
      }),
    );
    expect(r.source?.fixedAccountName).toBeNull();
    expect(r.source?.mapping.columns.accountName).toBeDefined();
    expect(r.source?.header?.[0]).toBe("日付");
  });

  it("見出しのない表の取込元は header が null", () => {
    const ctx = setup();
    const table = statementTableOf([
      {
        accountName: "サンプル銀行",
        date: "2026-05-10",
        content: "ショップ001",
        amount: -1200,
        transferFlag: false,
      },
    ]);
    const lines = table.text.split("\n").slice(1).join("\n");
    const r = unwrap(
      commitStatementImport(ctx.deps, {
        ...table,
        text: lines,
        mapping: { ...table.mapping, headerRow: null },
        origin: "paste",
        sha256: SHA,
        expected: { inputSha256: SHA, countNew: 1 },
        saveSource: { name: "見出しなし" },
      }),
    );
    expect(r.source?.header).toBeNull();
    expect(r.source?.mapping.headerRow).toBeNull();
  });

  it("id があれば更新: 対応・署名・口座名・名前・last_used_at を更新し、id と createdAt は変えない。監査は update", () => {
    const ctx = setup();
    const first = unwrap(commit(ctx, { name: "銀行" }));
    const created = first.source;
    if (created === null) throw new Error("source");
    ctx.clock.value = "2026-11-30T09:00:00.000Z";
    // 翌月分: 前置きが 5 行、見出しの行が 5、金額の列が変わった（今回は同じ内容で行を足さない）
    const text = [
      ...Array.from({ length: 2 }, (_, i) => `"説明${i}","x"`),
      readStatementText("bank-two-columns.utf8.csv"),
    ].join("\n");
    const mapping = { ...BANK_MAPPING, headerRow: 5 };
    const r = unwrap(
      commit(
        ctx,
        { id: created.id, name: "銀行（普通）" },
        { text, mapping, sha256: "b".repeat(64) },
      ),
    );
    expect(r.source).toMatchObject({
      id: created.id,
      name: "銀行（普通）",
      mapping: { headerRow: 5 },
      lastUsedAt: "2026-11-30T09:00:00.000Z",
      createdAt: created.createdAt,
      updatedAt: "2026-11-30T09:00:00.000Z",
    });
    expect(ctx.state.sources).toHaveLength(1);
    expect(r.batch.sourceName).toBe("銀行（普通）");
    const audits = ctx.state.audits.filter((a) => a.targetType === "statement_source");
    expect(audits.map((a) => a.action)).toEqual(["create", "update"]);
    expect(JSON.parse(audits[1]?.beforeJson ?? "null")).toMatchObject({ name: "銀行" });
  });

  it("id の取込元がなければ STATEMENT_SOURCE_NOT_FOUND で、何も書かない", () => {
    const ctx = setup();
    const before = snapshotOf(ctx.inner);
    expect(codeOf(commit(ctx, { id: "nothing", name: "銀行" }))).toBe("STATEMENT_SOURCE_NOT_FOUND");
    expect(snapshotOf(ctx.inner)).toEqual(before);
  });

  it("名前が別の取込元と重複すれば STATEMENT_SOURCE_NAME_TAKEN で、何も書かない（新規も更新も）", () => {
    const ctx = setup();
    unwrap(commit(ctx, { name: "A" }));
    ctx.clock.value = "2026-11-30T09:00:00.000Z";
    const b = unwrap(commit(ctx, { name: "B" }, { sha256: "c".repeat(64) })).source;
    if (b === null) throw new Error("source");
    const before = snapshotOf(ctx.inner);
    expect(codeOf(commit(ctx, { name: "A" }, { sha256: "d".repeat(64) }))).toBe(
      "STATEMENT_SOURCE_NAME_TAKEN",
    );
    expect(codeOf(commit(ctx, { id: b.id, name: "A" }, { sha256: "d".repeat(64) }))).toBe(
      "STATEMENT_SOURCE_NAME_TAKEN",
    );
    expect(snapshotOf(ctx.inner)).toEqual(before);
  });

  it("自分の名前のままの更新は重複にならない。空の名前は VALIDATION", () => {
    const ctx = setup();
    const a = unwrap(commit(ctx, { name: "A" })).source;
    if (a === null) throw new Error("source");
    expect(codeOf(commit(ctx, { id: a.id, name: "A" }, { sha256: "b".repeat(64) }))).toBe("ok");
    expect(codeOf(commit(ctx, { name: "   " }, { sha256: "c".repeat(64) }))).toBe("VALIDATION");
  });

  it("取込が失敗すれば取込元も残らない（口座が未対応・件数の食い違い・ハッシュの食い違い）", () => {
    const ctx = setup();
    const before = snapshotOf(ctx.inner);
    expect(codeOf(commit(ctx, { name: "A" }, { fixedAccountName: "未対応の口座" }))).toBe(
      "STATEMENT_ACCOUNT_UNMAPPED",
    );
    const input = bankInput();
    expect(
      codeOf(
        commitStatementImport(ctx.deps, {
          ...input,
          expected: { inputSha256: SHA, countNew: 999 },
          saveSource: { name: "A" },
        }),
      ),
    ).toBe("STATEMENT_PLAN_CHANGED");
    expect(
      codeOf(
        commitStatementImport(ctx.deps, {
          ...input,
          expected: { inputSha256: "e".repeat(64), countNew: 10 },
          saveSource: { name: "A" },
        }),
      ),
    ).toBe("STATEMENT_PLAN_CHANGED");
    expect(snapshotOf(ctx.inner)).toEqual(before);
  });
});

describe("INV-47（取込元の側）: 取込の途中で失敗すれば、明細・取込の回・取込元のどれも残らない", () => {
  it("任意の書き込みで失敗させる。失敗しなければ 3 つとも残る", () => {
    let injected = 0;
    let succeeded = 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.boolean(), (failAt, update) => {
        const ctx = setup();
        let id: string | undefined;
        if (update) {
          id = unwrap(commit(ctx, { name: "前の名前" })).source?.id;
        }
        const before = snapshotOf(ctx.inner);
        ctx.injector.failAt = failAt;
        let thrown = false;
        let result: ReturnType<typeof commit> | undefined;
        try {
          result = commit(
            ctx,
            { ...(id === undefined ? {} : { id }), name: "新しい名前" },
            { sha256: "f".repeat(64) },
          );
        } catch {
          thrown = true;
        }
        ctx.injector.failAt = null;
        if (thrown || result?.ok !== true) {
          injected += 1;
          expect(snapshotOf(ctx.inner)).toEqual(before);
        } else {
          succeeded += 1;
          expect(ctx.state.sources.map((s) => s.name)).toEqual(["新しい名前"]);
          expect(ctx.state.batches.at(-1)?.sourceName).toBe("新しい名前");
          expect(ctx.state.batches).toHaveLength(update ? 2 : 1);
          expect(ctx.state.statements.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 60 },
    );
    expect(injected).toBeGreaterThan(0);
    expect(succeeded).toBeGreaterThan(0);
  });
});
