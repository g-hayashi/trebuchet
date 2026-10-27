import { describe, expect, it } from "vitest";
import { domainError, err, ok } from "../../src/types.ts";
import {
  COLUMN_TIMEOUT_DETAIL,
  suggestStatementColumns,
} from "../../src/usecases/statement-columns.ts";
import { FakeColumnSuggestionProvider } from "../fakes.ts";

// 007 T016（R10、FR-016、contracts §4.1）。辞書の案で必須がそろうか、保存した対応が当てはまれば AI を呼ばない。
// 使えない・時間切れ・形の誤りは unavailable の理由にして、案なしで返す

type Layout = Parameters<typeof suggestStatementColumns>[1];

const NO_MATCH = { kind: "none" } as const;
const layout = (over: Partial<Layout> = {}): Layout => ({
  header: ["A", "B", "C", "D"],
  sampleRows: [["2026/04/01", "店", "-500", "メモ"]],
  columnCount: 4,
  suggestedColumns: {},
  match: NO_MATCH,
  ...over,
});

const GOOD = {
  columns: { date: 0, content: 1, amount: 2 },
  amountSign: "inflow_positive",
  confidence: 85,
  reason: "値の形から",
};

const provider = (available = true) => new FakeColumnSuggestionProvider({ available });

describe("suggestStatementColumns", () => {
  it("provider がなければ disabled（呼ばない）", async () => {
    const r = await suggestStatementColumns({ provider: undefined }, layout());
    expect(r).toEqual({ suggestion: null, unavailable: "disabled" });
  });

  it("使えない（available が false）なら unavailable。suggestColumns は呼ばない", async () => {
    const p = provider(false);
    const r = await suggestStatementColumns({ provider: p }, layout());
    expect(r).toEqual({ suggestion: null, unavailable: "unavailable" });
    expect(p.calls).toHaveLength(0);
  });

  it("辞書の案で必須がそろえば呼ばない（unavailable も付けない）", async () => {
    const p = provider();
    const r = await suggestStatementColumns(
      { provider: p },
      layout({ suggestedColumns: { date: 0, content: 1, outflow: 2, inflow: 3 } }),
    );
    expect(r).toEqual({ suggestion: null });
    expect(p.calls).toHaveLength(0);
    expect(p.availableCalls).toBe(0);
  });

  it("保存した対応が当てはまれば呼ばない", async () => {
    const p = provider();
    const source = {} as never;
    const matches: Layout["match"][] = [
      { kind: "one", source },
      { kind: "many", sources: [source, source] },
    ];
    for (const match of matches) {
      const r = await suggestStatementColumns({ provider: p }, layout({ match }));
      expect(r).toEqual({ suggestion: null });
    }
    expect(p.calls).toHaveLength(0);
  });

  it("必須がそろわなければ呼び、検証を通った案を返す。プロンプトは layout から作る", async () => {
    const p = provider();
    p.respondWith(ok(GOOD));
    const r = await suggestStatementColumns(
      { provider: p },
      layout({ suggestedColumns: { date: 0 } }),
    );
    expect(r).toEqual({
      suggestion: {
        columns: { date: 0, content: 1, amount: 2 },
        amountSign: "inflow_positive",
        confidence: 85,
        reason: "値の形から",
      },
    });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]?.messages[1]?.content).toContain("メモ");
  });

  it("JSON の文字列で返しても読む", async () => {
    const p = provider();
    p.respondWith(ok(JSON.stringify(GOOD)));
    const r = await suggestStatementColumns({ provider: p }, layout());
    expect(r.suggestion?.columns).toEqual({ date: 0, content: 1, amount: 2 });
  });

  it("provider の失敗は unavailable、時間切れの印があれば timeout", async () => {
    const p = provider();
    p.respondWith(err(domainError("VALIDATION", "AI に接続できません")));
    expect(await suggestStatementColumns({ provider: p }, layout())).toEqual({
      suggestion: null,
      unavailable: "unavailable",
    });
    p.respondWith(
      err(domainError("VALIDATION", "AI の応答が時間内に返りませんでした", COLUMN_TIMEOUT_DETAIL)),
    );
    expect(await suggestStatementColumns({ provider: p }, layout())).toEqual({
      suggestion: null,
      unavailable: "timeout",
    });
  });

  it("provider が例外を投げても unavailable", async () => {
    const p = provider();
    p.throwOnCall = true;
    expect(await suggestStatementColumns({ provider: p }, layout())).toEqual({
      suggestion: null,
      unavailable: "unavailable",
    });
  });

  it("形・列の範囲・必須が外れた出力は invalid", async () => {
    const p = provider();
    for (const raw of [
      "JSON ではない",
      { ...GOOD, columns: { date: 0, content: 1, amount: 9 } },
      { ...GOOD, columns: { date: 0, amount: 2 } },
    ]) {
      p.respondWith(ok(raw));
      expect(await suggestStatementColumns({ provider: p }, layout())).toEqual({
        suggestion: null,
        unavailable: "invalid",
      });
    }
  });
});
