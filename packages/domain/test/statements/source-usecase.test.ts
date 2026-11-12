import type { StatementSource } from "@trebuchet/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteStatementSource,
  listStatementSources,
  renameStatementSource,
} from "../../src/usecases/statement-sources.ts";
import { codeOf, unwrap } from "../result.ts";
import { setupStatements } from "../statements-setup.ts";

// 007 T012（R7、FR-012）: 取込元の一覧・名前の変更・削除

const source = (id: string, name: string, lastUsedAt: string): StatementSource => ({
  id,
  name,
  fixedAccountName: null,
  mapping: {
    delimiter: "\t",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2, accountName: 3 },
    amountSign: "inflow_positive",
  },
  header: ["日付", "内容", "金額", "口座"],
  lastUsedAt,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: lastUsedAt,
});

let ctx: ReturnType<typeof setupStatements>;
beforeEach(() => {
  ctx = setupStatements();
  ctx.uow.statements.state.sources.push(
    source("a", "カードA", "2026-08-01T00:00:00.000Z"),
    source("b", "カードB", "2026-10-01T00:00:00.000Z"),
    source("c", "まとめ", "2026-09-01T00:00:00.000Z"),
  );
});

describe("listStatementSources", () => {
  it("last_used_at の新しい順", () => {
    expect(unwrap(listStatementSources(ctx.deps)).map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("last_used_at が同じなら名前のコードポイント順（ロケールに依らない。大文字が小文字より前）", () => {
    const sameAt = "2026-12-01T00:00:00.000Z";
    ctx.uow.statements.state.sources.push(
      source("d", "apple", sameAt),
      source("e", "Banana", sameAt),
    );
    expect(
      unwrap(listStatementSources(ctx.deps))
        .slice(0, 2)
        .map((s) => s.id),
    ).toEqual(["e", "d"]);
  });
});

describe("renameStatementSource", () => {
  it("名前と updated_at を変え、ほかは変えない。監査に update を残す", () => {
    ctx.clock.value = "2026-11-01T00:00:00.000Z";
    const renamed = unwrap(renameStatementSource(ctx.deps, "a", "  新しい名前 "));
    expect(renamed).toMatchObject({
      id: "a",
      name: "新しい名前",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastUsedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(ctx.uow.statements.state.sources.find((s) => s.id === "a")?.name).toBe("新しい名前");
    const audit = ctx.uow.statements.state.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "statement_source",
      targetId: "a",
      action: "update",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ name: "カードA" });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ name: "新しい名前" });
  });

  it("同じ名前への変更は何も書かない", () => {
    unwrap(renameStatementSource(ctx.deps, "a", "カードA"));
    expect(ctx.uow.statements.state.audits).toEqual([]);
  });

  it("別の取込元と重複すれば STATEMENT_SOURCE_NAME_TAKEN、ない id は STATEMENT_SOURCE_NOT_FOUND", () => {
    expect(codeOf(renameStatementSource(ctx.deps, "a", "カードB"))).toBe(
      "STATEMENT_SOURCE_NAME_TAKEN",
    );
    expect(codeOf(renameStatementSource(ctx.deps, "nothing", "X"))).toBe(
      "STATEMENT_SOURCE_NOT_FOUND",
    );
    expect(ctx.uow.statements.state.audits).toEqual([]);
  });

  it("名前は 1〜100 字（空・空白だけ・101 字は VALIDATION）", () => {
    expect(codeOf(renameStatementSource(ctx.deps, "a", ""))).toBe("VALIDATION");
    expect(codeOf(renameStatementSource(ctx.deps, "a", "  "))).toBe("VALIDATION");
    expect(codeOf(renameStatementSource(ctx.deps, "a", "あ".repeat(101)))).toBe("VALIDATION");
    expect(codeOf(renameStatementSource(ctx.deps, "a", "あ".repeat(100)))).toBe("ok");
  });
});

describe("deleteStatementSource", () => {
  it("取込元を消し、監査に delete を残す。取込の回・明細は変えない", () => {
    ctx.uow.statements.state.batches.push({
      id: "batch-1",
      origin: "file",
      sourceName: "カードA",
      inputSha256: "a".repeat(64),
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      countNew: 1,
      countExisting: 0,
      countUnreadable: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    });
    const batchesBefore = structuredClone(ctx.uow.statements.state.batches);
    unwrap(deleteStatementSource(ctx.deps, "a"));
    expect(ctx.uow.statements.state.sources.map((s) => s.id)).toEqual(["b", "c"]);
    expect(ctx.uow.statements.state.batches).toEqual(batchesBefore);
    const audit = ctx.uow.statements.state.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "statement_source",
      targetId: "a",
      action: "delete",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ name: "カードA" });
    expect(audit?.afterJson).toBeNull();
  });

  it("ない id は STATEMENT_SOURCE_NOT_FOUND", () => {
    expect(codeOf(deleteStatementSource(ctx.deps, "nothing"))).toBe("STATEMENT_SOURCE_NOT_FOUND");
    expect(ctx.uow.statements.state.sources).toHaveLength(3);
  });
});
