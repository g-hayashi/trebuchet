import type { StatementColumnMapping, StatementSource } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import {
  applySourceToLayout,
  diffHeader,
  headerSignature,
  inheritColumns,
  matchStatementSources,
  sourceFitsLayout,
} from "../../src/statements/sources.ts";
import { detectStatementLayout } from "../../src/usecases/statements.ts";
import { fakeStatementUnitOfWork } from "../fakes.ts";
import { BANK_TWO_COLUMNS, NO_HEADER } from "../fixtures/statements/expected.ts";
import { readStatementText } from "../fixtures/statements/load.ts";
import { setupBase } from "../ledger-setup.ts";

// 007 T012（R7・R8、FR-011）。取込元の照合: 署名・当てはめ・見出しの違い

const BANK_MAPPING: StatementColumnMapping = {
  delimiter: ",",
  headerRow: 3,
  columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
};
const BANK_HEADER = ["取引日", "摘要", "出金額", "入金額", "残高"];

const source = (over: Partial<StatementSource> = {}): StatementSource => ({
  id: "src-1",
  name: "銀行",
  fixedAccountName: "サンプル銀行",
  mapping: BANK_MAPPING,
  header: headerSignature(BANK_HEADER),
  lastUsedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const bankText = () => readStatementText("bank-two-columns.utf8.csv");

/** 前置きの行数を変えた同じ銀行の CSV（見出しより前を `lines` 行にする） */
const withPreamble = (text: string, lines: number): string => {
  const rows = text.split("\n").slice(BANK_TWO_COLUMNS.preambleLines);
  const preamble = Array.from({ length: lines }, (_, i) => `"説明${i + 1}","ダミー"`);
  return [...preamble, ...rows].join("\n");
};

describe("headerSignature", () => {
  it("null は null。見出しは normalizeHeaderName を掛けた配列（括弧書き・空白・全角・大文字小文字を除く）", () => {
    expect(headerSignature(null)).toBeNull();
    expect(headerSignature(["取引日", "出金額（円）", " Ｄａｔｅ ", "ID"])).toEqual([
      "取引日",
      "出金額",
      "date",
      "id",
    ]);
  });
});

describe("matchStatementSources", () => {
  const layout = { header: BANK_HEADER, headerRow: 3, columnCount: 5 };

  it("署名が一致する取込元がなければ none（見出しの違い・順序の違いは当たらない）", () => {
    expect(matchStatementSources(layout, [])).toEqual({ kind: "none" });
    const other = source({
      header: headerSignature(["取引日", "摘要", "入金額", "出金額", "残高"]),
    });
    expect(matchStatementSources(layout, [other])).toEqual({ kind: "none" });
  });

  it("1 件: one。正規化の違い（全角・括弧書き）は同じ署名", () => {
    const s = source({
      header: headerSignature(["取引日", "摘要", "出金額（円）", "入金額", "残高"]),
    });
    const m = matchStatementSources(layout, [s, source({ id: "x", header: ["別"] })]);
    expect(m.kind).toBe("one");
    expect(m.kind === "one" && m.source.id).toBe("src-1");
  });

  it("当てはめる対応の見出しの行は今回の判定の行。区切り文字・列・符号の向きは保存した値（R8）", () => {
    const s = source({
      mapping: {
        ...BANK_MAPPING,
        headerRow: 0,
        columns: { date: 0, content: 1, amount: 2 },
        amountSign: "outflow_positive",
      },
    });
    const m = matchStatementSources({ ...layout, headerRow: 5 }, [s]);
    expect(m.kind === "one" && m.source.mapping).toEqual({
      delimiter: ",",
      headerRow: 5,
      columns: { date: 0, content: 1, amount: 2 },
      amountSign: "outflow_positive",
    });
    // 元の取込元は変えない
    expect(s.mapping.headerRow).toBe(0);
    expect(applySourceToLayout(s, { headerRow: null }).mapping.headerRow).toBeNull();
  });

  it("2 件以上: many は last_used_at の新しい順", () => {
    const a = source({ id: "a", name: "カードA", lastUsedAt: "2026-08-01T00:00:00.000Z" });
    const b = source({ id: "b", name: "カードB", lastUsedAt: "2026-10-20T00:00:00.000Z" });
    const c = source({ id: "c", name: "カードC", lastUsedAt: "2026-09-10T00:00:00.000Z" });
    const m = matchStatementSources(layout, [a, b, c]);
    expect(m.kind === "many" && m.sources.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("見出しのない表・見出しのない取込元は署名で探せない", () => {
    expect(
      matchStatementSources({ header: null, headerRow: null, columnCount: 5 }, [
        source({ header: null }),
      ]),
    ).toEqual({ kind: "none" });
    expect(matchStatementSources(layout, [source({ header: null })])).toEqual({ kind: "none" });
  });
});

describe("diffHeader / inheritColumns", () => {
  it("足された列・なくなった列。同じ名前は出てくる順に 1 対 1", () => {
    const d = diffHeader(headerSignature(BANK_HEADER) as string[], [
      "取引日",
      "摘要",
      "メモ",
      "入金額",
      "残高",
      "残高",
    ]);
    expect(d.added).toEqual(["メモ", "残高"]);
    expect(d.removed).toEqual(["出金額"]);
    expect(d.matched).toEqual([0, 1, undefined, 3, 4, undefined]);
  });

  it("名前が同じ列の役割を引き継ぐ（列がずれても追う）。引き継げない役割は入れない", () => {
    const s = source();
    const header = ["区分", "取引日", "摘要", "出金額", "メモ"];
    const inherited = inheritColumns(s, header, { date: 1, content: 2, outflow: 3, memo: 4 });
    // inflow（入金額）は表にない。memo は辞書の案
    expect(inherited).toEqual({ date: 1, content: 2, outflow: 3, memo: 4 });
  });

  it("辞書の案が、引き継いだ列と衝突するときは引き継いだ方が優先", () => {
    const s = source();
    const header = ["取引日", "摘要", "出金額", "入金額"];
    const inherited = inheritColumns(s, header, { date: 0, content: 1, amount: 2 });
    expect(inherited).toEqual({ date: 0, content: 1, outflow: 2, inflow: 3 });
  });
});

describe("sourceFitsLayout（手で選んだ取込元）", () => {
  it("見出しがある取込元は署名が一致するときだけ", () => {
    const layout = { header: BANK_HEADER, headerRow: 3, columnCount: 5 };
    expect(sourceFitsLayout(source(), layout)).toBe(true);
    expect(sourceFitsLayout(source(), { ...layout, header: ["取引日", "摘要"] })).toBe(false);
    expect(sourceFitsLayout(source(), { header: null, headerRow: null, columnCount: 5 })).toBe(
      false,
    );
  });

  it("見出しのない取込元は、表も見出しがなく、対応の列が表に収まるときだけ", () => {
    const s = source({ header: null, mapping: { ...BANK_MAPPING, headerRow: null } });
    expect(sourceFitsLayout(s, { header: null, headerRow: null, columnCount: 4 })).toBe(true);
    expect(sourceFitsLayout(s, { header: null, headerRow: null, columnCount: 3 })).toBe(false);
    expect(sourceFitsLayout(s, { header: BANK_HEADER, headerRow: 0, columnCount: 5 })).toBe(false);
  });
});

describe("detectStatementLayout と取込元（R8・FR-011）", () => {
  const setup = (sources: StatementSource[] = []) => {
    const base = setupBase();
    const uow = fakeStatementUnitOfWork(base.ledger, base.masters);
    uow.statements.state.sources.push(...sources);
    return { uow, deps: { uow, ids: base.ids, clock: base.clock } };
  };
  const detect = (
    ctx: ReturnType<typeof setup>,
    text: string,
    override?: Parameters<typeof detectStatementLayout>[2],
  ) => {
    const r = detectStatementLayout(ctx.deps, text, override);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };

  it("取込元がなければ match は none、headerDiff はない", () => {
    const layout = detect(setup(), bankText());
    expect(layout.match).toEqual({ kind: "none" });
    expect(layout.headerDiff).toBeUndefined();
  });

  it("前置きの行数が違う翌月分でも署名で当たり、見出しの行は今回の行になる（R8）", () => {
    const ctx = setup([source()]);
    for (const preamble of [0, 3, 5]) {
      const layout = detect(ctx, withPreamble(bankText(), preamble));
      expect(layout.headerRow).toBe(preamble);
      expect(layout.match.kind).toBe("one");
      expect(layout.match.kind === "one" && layout.match.source.mapping.headerRow).toBe(preamble);
      expect(layout.match.kind === "one" && layout.match.source.mapping.columns).toEqual(
        BANK_MAPPING.columns,
      );
    }
  });

  it("2 件が当たれば many（新しい順）", () => {
    const ctx = setup([
      source({ id: "a", name: "A", lastUsedAt: "2026-08-01T00:00:00.000Z" }),
      source({ id: "b", name: "B", lastUsedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const layout = detect(ctx, bankText());
    expect(layout.match.kind === "many" && layout.match.sources.map((s) => s.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("sourceId がなければ STATEMENT_SOURCE_NOT_FOUND", () => {
    const r = detectStatementLayout(setup().deps, bankText(), { sourceId: "nothing" });
    expect(!r.ok && r.error.code).toBe("STATEMENT_SOURCE_NOT_FOUND");
  });

  it("sourceId を指定し署名が同じなら one（ほかの取込元が当たっていても指定を使う）", () => {
    const ctx = setup([
      source({ id: "a", name: "A", lastUsedAt: "2026-10-01T00:00:00.000Z" }),
      source({ id: "b", name: "B", lastUsedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    const layout = detect(ctx, bankText(), { sourceId: "b" });
    expect(layout.match.kind === "one" && layout.match.source.id).toBe("b");
    expect(layout.headerDiff).toBeUndefined();
  });

  it("sourceId を指定し見出しが違えば、one にせず headerDiff と役割を引き継いだ案を返す", () => {
    // 辞書にない名前の見出し。前に 1 列、後ろに 1 列が足された
    const custom = source({
      id: "custom",
      header: headerSignature(["ご利用日時", "ご利用内容", "差引額"]),
      mapping: {
        delimiter: ",",
        headerRow: 0,
        columns: { date: 0, content: 1, amount: 2 },
        amountSign: "outflow_positive",
      },
    });
    const text = [
      '"区分","ご利用日時","ご利用内容","差引額","新列"',
      '"x","2026/10/01","買物","-1000","y"',
      '"x","2026/10/02","食事","-2000","y"',
    ].join("\n");
    const ctx = setup([custom]);
    const layout = detect(ctx, text, { sourceId: "custom" });
    expect(layout.suggestedColumns).toEqual({ date: 1, content: 2, amount: 3 });
    expect(layout.match).toEqual({ kind: "none" });
    expect(layout.headerDiff).toEqual({ added: ["区分", "新列"], removed: [] });
  });

  it("見出しのない取込元は、見出しのない表で列が収まるときだけ当てはめる", () => {
    const text = readStatementText(NO_HEADER.file);
    const noHeader = source({
      id: "n",
      header: null,
      mapping: { ...NO_HEADER.mapping, headerRow: null } as StatementColumnMapping,
    });
    const ctx = setup([noHeader]);
    const layout = detect(ctx, text, { sourceId: "n" });
    expect(layout.headerRow).toBeNull();
    expect(layout.match.kind).toBe("one");
    // 自動の照合（sourceId なし）には当たらない
    expect(detect(ctx, text).match).toEqual({ kind: "none" });
    // 見出しのある表には当てはめない
    expect(detect(ctx, bankText(), { sourceId: "n" }).match).toEqual({ kind: "none" });
  });
});
