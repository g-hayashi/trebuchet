import { describe, expect, it } from "vitest";
import { domainError, err, ok } from "../../src/types.ts";
import {
  COLUMN_TIMEOUT_DETAIL,
  evaluateColumnSuggestions,
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

/** 見本の行がない表（中身からの推定ができない。AI を使えないときは、案なしと理由だけ） */
const NO_SAMPLES = layout({ sampleRows: [] });

const GOOD = {
  roles: ["date", "content", "amount", "none"],
  amountSign: "inflow_positive",
  confidence: 85,
};

const provider = (available = true) => new FakeColumnSuggestionProvider({ available });

describe("suggestStatementColumns", () => {
  it("provider がなければ disabled（呼ばない）", async () => {
    const r = await suggestStatementColumns({ provider: undefined }, NO_SAMPLES);
    expect(r).toEqual({ suggestion: null, unavailable: "disabled" });
  });

  it("使えない（available が false）なら unavailable。suggestColumns は呼ばない", async () => {
    const p = provider(false);
    const r = await suggestStatementColumns({ provider: p }, NO_SAMPLES);
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
    expect(await suggestStatementColumns({ provider: p }, NO_SAMPLES)).toEqual({
      suggestion: null,
      unavailable: "unavailable",
    });
    p.respondWith(
      err(domainError("VALIDATION", "AI の応答が時間内に返りませんでした", COLUMN_TIMEOUT_DETAIL)),
    );
    expect(await suggestStatementColumns({ provider: p }, NO_SAMPLES)).toEqual({
      suggestion: null,
      unavailable: "timeout",
    });
  });

  it("provider が例外を投げても unavailable", async () => {
    const p = provider();
    p.throwOnCall = true;
    expect(await suggestStatementColumns({ provider: p }, NO_SAMPLES)).toEqual({
      suggestion: null,
      unavailable: "unavailable",
    });
  });

  describe("見本の値での検査と、中身からの推定（007/R16）", () => {
    const CARD_ROWS = [
      ["26/10/31", "テスト商店A", "ご本人", "リボ払い", "26/11", "4,100"],
      ["26/10/26", "TEST ONLINE", "ご本人", "リボ払い", "26/11", "1,800"],
      ["26/10/20", "テスト商店B", "ご本人", "リボ払い", "26/11", "3,000"],
    ];
    const cardLayout = (over: Partial<Layout> = {}) =>
      layout({
        header: ["A", "B", "C", "D", "E", "F"],
        sampleRows: CARD_ROWS,
        columnCount: 6,
        ...over,
      });

    it("金額でない列を出金にした案は捨て（対の入金も）、中身から金額を推定する", async () => {
      const p = provider();
      p.respondWith(
        ok({
          roles: ["date", "content", "none", "outflow", "none", "inflow"],
          amountSign: null,
          confidence: 70,
        }),
      );
      const r = await suggestStatementColumns({ provider: p }, cardLayout());
      expect(r).toEqual({
        suggestion: {
          columns: { date: 0, content: 1, amount: 5 },
          amountSign: null,
          confidence: 70,
        },
      });
    });

    it("年月の列を金額にし、金額の列を大項目にした案は、金額を推定して大項目を外す", async () => {
      const p = provider();
      p.respondWith(
        ok({
          roles: ["date", "content", "none", "none", "amount", "categoryMajor"],
          amountSign: "inflow_positive",
          confidence: 60,
        }),
      );
      const r = await suggestStatementColumns({ provider: p }, cardLayout());
      // 推定した金額に、AI の符号の案は引き継がない（AI が選んだ金額の列ではない）
      expect(r.suggestion).toEqual({
        columns: { date: 0, content: 1, amount: 5 },
        amountSign: null,
        confidence: 60,
      });
    });

    it("日付として読めない列を日付にした案は捨て、日付の列を推定する。残りの役割と符号は残す", async () => {
      const p = provider();
      p.respondWith(
        ok({
          roles: ["none", "content", "none", "date", "none", "amount"],
          amountSign: "inflow_positive",
          confidence: 80,
        }),
      );
      const r = await suggestStatementColumns({ provider: p }, cardLayout());
      expect(r.suggestion).toEqual({
        columns: { content: 1, amount: 5, date: 0 },
        amountSign: "inflow_positive",
        confidence: 80,
      });
    });

    it("金額の列の見出しがご利用額などなら、符号の案は出金が正（AI の案より優先）", async () => {
      const p = provider();
      p.respondWith(
        ok({
          roles: ["date", "content", "none", "none", "none", "amount"],
          amountSign: "inflow_positive",
          confidence: 80,
        }),
      );
      const r = await suggestStatementColumns(
        { provider: p },
        cardLayout({ header: ["ご利用日", "店", "C", "D", "E", "ご利用額\n（割引後額）"] }),
      );
      expect(r.suggestion?.amountSign).toBe("outflow_positive");
    });

    describe("AI を使えない・失敗したときも、中身からの推定を案として返す", () => {
      const CONTENT_ONLY = {
        columns: { date: 0, content: 1, amount: 5 },
        amountSign: null,
        confidence: 0,
      };

      it("provider がなければ disabled と、中身からの推定（AI は呼ばない）", async () => {
        const r = await suggestStatementColumns({ provider: undefined }, cardLayout());
        expect(r).toEqual({ suggestion: CONTENT_ONLY, unavailable: "disabled" });
      });

      it("使えない・時間切れ・例外・形の誤りでも、理由つきで推定を返す", async () => {
        const p = provider(false);
        expect(await suggestStatementColumns({ provider: p }, cardLayout())).toEqual({
          suggestion: CONTENT_ONLY,
          unavailable: "unavailable",
        });
        const q = provider();
        q.respondWith(err(domainError("VALIDATION", "時間切れ", COLUMN_TIMEOUT_DETAIL)));
        expect(await suggestStatementColumns({ provider: q }, cardLayout())).toEqual({
          suggestion: CONTENT_ONLY,
          unavailable: "timeout",
        });
        q.respondWith(ok("JSON ではない"));
        expect(await suggestStatementColumns({ provider: q }, cardLayout())).toEqual({
          suggestion: CONTENT_ONLY,
          unavailable: "invalid",
        });
        q.throwOnCall = true;
        expect(await suggestStatementColumns({ provider: q }, cardLayout())).toEqual({
          suggestion: CONTENT_ONLY,
          unavailable: "unavailable",
        });
      });

      it("辞書の案を優先する（辞書にある役割・列は推定しない）。符号は見出しから", async () => {
        const r = await suggestStatementColumns(
          { provider: undefined },
          cardLayout({
            header: ["A", "ご利用額", "C", "D", "E", "F"],
            suggestedColumns: { content: 2 },
          }),
        );
        expect(r.suggestion?.columns).toEqual({ date: 0, amount: 5 });
        // 金額の列（5）の見出しは「F」なので符号の案はない
        expect(r.suggestion?.amountSign).toBeNull();
        const r2 = await suggestStatementColumns(
          { provider: undefined },
          cardLayout({ header: ["A", "B", "C", "D", "E", "ご利用額"] }),
        );
        expect(r2.suggestion?.amountSign).toBe("outflow_positive");
      });

      it("辞書の案で必須がそろえば、推定もしない（呼ばない判断は変えない）", async () => {
        const r = await suggestStatementColumns(
          { provider: undefined },
          cardLayout({ suggestedColumns: { date: 0, content: 1, amount: 5 } }),
        );
        expect(r).toEqual({ suggestion: null });
      });

      it("推定できる列がない（見本の行がない）ときは、案なしと理由だけ", async () => {
        const r = await suggestStatementColumns(
          { provider: undefined },
          cardLayout({ sampleRows: [] }),
        );
        expect(r).toEqual({ suggestion: null, unavailable: "disabled" });
      });

      it("評価（evaluateColumnSuggestions）では、AI の案ではないので案なしに数える", async () => {
        const result = await evaluateColumnSuggestions(
          [
            {
              name: "x",
              header: null,
              sampleRows: CARD_ROWS,
              columnCount: 6,
              expected: { columns: { date: 0, content: 1, amount: 5 } },
            },
          ],
          undefined,
        );
        expect(result.noSuggestionRate).toBe(1000);
        expect(result.allRequiredRate).toBe(0);
      });
    });

    it("見本の行がなければ検査も推定もせず、AI の案のまま", async () => {
      const p = provider();
      p.respondWith(ok(GOOD));
      const r = await suggestStatementColumns({ provider: p }, layout({ sampleRows: [] }));
      expect(r.suggestion?.columns).toEqual({ date: 0, content: 1, amount: 2 });
    });
  });

  it("形・列数との一致・必須が外れた出力は invalid", async () => {
    const p = provider();
    for (const raw of [
      "JSON ではない",
      { ...GOOD, roles: [...GOOD.roles, "memo"] },
      { ...GOOD, roles: GOOD.roles.map((r) => (r === "content" ? "none" : r)) },
    ]) {
      p.respondWith(ok(raw));
      expect(await suggestStatementColumns({ provider: p }, NO_SAMPLES)).toEqual({
        suggestion: null,
        unavailable: "invalid",
      });
    }
  });
});
