import { beforeEach, describe, expect, it } from "vitest";
import { excludeStatement } from "../../src/usecases/statement-approval.ts";
import { listStatements } from "../../src/usecases/statements.ts";
import { type StatementsCtx, setupStatements, unwrap } from "../statements-setup.ts";

// 006 T016（H:§4.1 の `duplicateOf`）: 重複の疑い（R3）を明細の一覧にも出す。判定は取込の計画と同じ

let ctx: StatementsCtx;
beforeEach(() => {
  ctx = setupStatements();
  ctx.mapAll();
});

const views = () => unwrap(listStatements(ctx.deps));

describe("duplicateOf", () => {
  it("口座・内容・金額が同じで日付が 3 日以内なら、互いの ID を出す", () => {
    ctx.importRows([
      ctx.row({ content: "ショップ001", date: "2026-05-10" }),
      ctx.row({ content: "ショップ001", date: "2026-05-13" }),
    ]);
    const [first, second] = ctx.statements();
    const byId = new Map(views().map((v) => [v.id, v]));
    expect(byId.get(first?.id as string)?.duplicateOf).toEqual([second?.id]);
    expect(byId.get(second?.id as string)?.duplicateOf).toEqual([first?.id]);
  });

  it("口座・日付・内容が同じで金額が違うときも出す", () => {
    ctx.importRows([
      ctx.row({ content: "テスト商店", amount: -1000 }),
      ctx.row({ content: "テスト商店", amount: -1100 }),
    ]);
    expect(views().every((v) => v.duplicateOf?.length === 1)).toBe(true);
  });

  it("日付が 4 日離れている・内容が違う・口座が違うなら出さない（項目自体がない）", () => {
    ctx.importRows([
      ctx.row({ content: "遠い店", date: "2026-05-01" }),
      ctx.row({ content: "遠い店", date: "2026-05-05" }),
      ctx.row({ content: "別の店", date: "2026-05-05" }),
      ctx.row({ content: "別の店", date: "2026-05-05", accountName: "テストカードA" }),
    ]);
    for (const v of views()) expect("duplicateOf" in v).toBe(false);
  });

  it("相手が除外済みでも未処理の側には出す。除外済みの側には出さない", () => {
    ctx.importRows([
      ctx.row({ content: "ショップ001", date: "2026-05-10" }),
      ctx.row({ content: "ショップ001", date: "2026-05-11" }),
    ]);
    const [first, second] = ctx.statements();
    unwrap(excludeStatement(ctx.deps, first?.id as string));
    const byId = new Map(views().map((v) => [v.id, v]));
    expect(byId.get(second?.id as string)?.duplicateOf).toEqual([first?.id]);
    expect("duplicateOf" in (byId.get(first?.id as string) ?? {})).toBe(false);
  });
});
