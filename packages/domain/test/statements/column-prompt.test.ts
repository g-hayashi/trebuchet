import { STATEMENT_COLUMN_ROLES } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import {
  buildColumnPrompt,
  hasRequiredColumns,
  parseColumnSuggestion,
} from "../../src/statements/column-prompt.ts";

// 007 T016・T022（R10）。プロンプトの形と、AI の出力（列ごとに役割 1 つ）の検証
// （形・列の範囲・index の重複・役割の重複・必須の役割）

/** 列ごとの役割の並び（添字が列の番号）から AI の出力の `columns` を作る */
const cols = (...roles: string[]) => roles.map((role, index) => ({ index, role }));

const SPLIT = {
  columns: cols("date", "content", "outflow", "inflow", "none"),
  amountSign: null,
  confidence: 80,
  reason: "見出しから判断",
};
const SINGLE = {
  columns: cols("date", "content", "amount"),
  amountSign: "outflow_positive",
  confidence: 70,
  reason: "金額が 1 列",
};

describe("buildColumnPrompt", () => {
  const layout = {
    header: ["日付", "内容", "金額"],
    sampleRows: [
      ["2026/04/01", "コンビニ", "-500"],
      ["2026/04/02", "電車", "-210"],
    ],
    columnCount: 3,
  };

  it("system と user の 2 メッセージと、json_schema 用の schema を返す", () => {
    const prompt = buildColumnPrompt(layout);
    expect(prompt.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const system = prompt.messages[0]?.content ?? "";
    for (const role of ["date", "content", "amount", "outflow", "inflow", "transferFlag"]) {
      expect(system).toContain(role);
    }
    expect(system).toContain("0 起点");
    expect(system).toContain("none");
    expect(system).toContain("amountSign");
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("コンビニ");
    expect(user).toContain("日付");
    expect(prompt.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("schema は列ごとに役割 1 つ（index と、役割か none の enum）。役割ごとの番号の形ではない", () => {
    const schema = buildColumnPrompt(layout).schema as {
      required: string[];
      properties: {
        columns: {
          type: string;
          items: {
            required: string[];
            additionalProperties: boolean;
            properties: { index: { type: string }; role: { enum: string[] } };
          };
        };
      };
    };
    expect(schema.required).toEqual(["columns", "amountSign", "confidence", "reason"]);
    const columns = schema.properties.columns;
    expect(columns.type).toBe("array");
    expect(columns.items.required).toEqual(["index", "role"]);
    expect(columns.items.additionalProperties).toBe(false);
    expect(columns.items.properties.index.type).toBe("integer");
    expect(columns.items.properties.role.enum).toEqual([...STATEMENT_COLUMN_ROLES, "none"]);
  });

  it("見出しがなくてもよい。列数の違う行（前置き）は数えずに飛ばす", () => {
    const prompt = buildColumnPrompt({
      header: null,
      sampleRows: [
        ["前置きの印", "x"],
        ["2026/04/01", "店", "-500"],
      ],
      columnCount: 3,
    });
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("2026/04/01");
    expect(user).not.toContain("前置きの印");
    expect(JSON.parse(user).columns[0].header).toBeNull();
  });
});

describe("hasRequiredColumns", () => {
  it("日付・内容と、金額か出金・入金の一方がそろえば true", () => {
    expect(hasRequiredColumns({ date: 0, content: 1, amount: 2 })).toBe(true);
    expect(hasRequiredColumns({ date: 0, content: 1, outflow: 2, inflow: 3 })).toBe(true);
    expect(hasRequiredColumns({ date: 0, content: 1, outflow: 2 })).toBe(false);
    expect(hasRequiredColumns({ date: 0, amount: 2 })).toBe(false);
    expect(hasRequiredColumns({ date: 0, content: 1, amount: 2, outflow: 3, inflow: 4 })).toBe(
      false,
    );
    expect(hasRequiredColumns({})).toBe(false);
  });
});

describe("parseColumnSuggestion", () => {
  it("出金・入金の 2 列。none の列は落とし、amountSign は null になる", () => {
    const r = parseColumnSuggestion(SPLIT, 5);
    expect(r).toEqual({
      ok: true,
      value: {
        columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
        amountSign: null,
        confidence: 80,
        reason: "見出しから判断",
      },
    });
  });

  it("金額 1 列と amountSign", () => {
    const r = parseColumnSuggestion(SINGLE, 3);
    expect(r.ok && r.value.amountSign).toBe("outflow_positive");
  });

  it("JSON の文字列（コードフェンス・前後の文章つきも）を読む", () => {
    expect(parseColumnSuggestion(JSON.stringify(SPLIT), 5).ok).toBe(true);
    expect(parseColumnSuggestion(`はい\n\`\`\`json\n${JSON.stringify(SINGLE)}\n\`\`\``, 3).ok).toBe(
      true,
    );
  });

  it("外れれば案なし", () => {
    const bad = (raw: unknown, columnCount = 5) => {
      const r = parseColumnSuggestion(raw, columnCount);
      expect(r.ok).toBe(false);
    };
    bad("JSON ではない");
    bad(null);
    bad({ ...SPLIT, columns: [{ index: "A", role: "date" }] });
    bad({ ...SPLIT, columns: { date: 0, content: 1, amount: 2 } }); // 旧い形
    bad({ ...SPLIT, columns: [...SPLIT.columns.slice(0, 4), { index: 4, role: "bogus" }] });
    bad({ ...SPLIT, confidence: 101 });
    bad({ ...SPLIT, reason: "あ".repeat(201) });
    // 列の範囲（0〜columnCount-1）
    bad(SPLIT, 3);
    bad({ ...SPLIT, columns: [{ index: -1, role: "date" }, ...SPLIT.columns.slice(1)] });
    // 同じ index が 2 回出れば失敗
    bad({ ...SPLIT, columns: [...SPLIT.columns, { index: 0, role: "memo" }] });
    // 必須の役割（捨てた後も含めて）
    bad({ ...SPLIT, columns: cols("date", "content", "outflow", "none") });
    bad({ ...SINGLE, columns: cols("date", "none", "amount") });
    bad({ ...SINGLE, columns: cols("none", "none", "none") });
    bad({ ...SINGLE, columns: [] });
  });

  it("同じ役割が複数の列に付いたら、その役割だけ捨てて他は残す", () => {
    // memo が 2 列 → memo だけ捨てる
    const r = parseColumnSuggestion(
      { ...SINGLE, columns: cols("date", "content", "amount", "memo", "memo") },
      5,
    );
    expect(r.ok && r.value.columns).toEqual({ date: 0, content: 1, amount: 2 });
    // 必須の役割が重複すれば捨てた結果そろわず失敗（date が 2 列）
    expect(
      parseColumnSuggestion({ ...SINGLE, columns: cols("date", "content", "amount", "date") }, 4)
        .ok,
    ).toBe(false);
    // 金額が 2 列でも、出金・入金の対があればそちらを採る
    const split = parseColumnSuggestion(
      { ...SPLIT, columns: cols("date", "content", "outflow", "inflow", "amount", "amount") },
      6,
    );
    expect(split.ok && split.value.columns).toEqual({ date: 0, content: 1, outflow: 2, inflow: 3 });
    // 金額が 2 列で、出金・入金の対がなければ失敗
    expect(
      parseColumnSuggestion({ ...SINGLE, columns: cols("date", "content", "amount", "amount") }, 4)
        .ok,
    ).toBe(false);
  });

  it("金額と出金・入金がともにあれば出金・入金の対を採り、金額と amountSign は捨てる。片方だけなら金額を採る", () => {
    const both = parseColumnSuggestion(
      {
        ...SINGLE,
        columns: cols("date", "content", "amount", "outflow", "inflow"),
      },
      5,
    );
    expect(both).toEqual({
      ok: true,
      value: {
        columns: { date: 0, content: 1, outflow: 3, inflow: 4 },
        amountSign: null,
        confidence: 70,
        reason: "金額が 1 列",
      },
    });
    // 出金だけ（入金なし）なら金額を採り、出金は捨てる
    const half = parseColumnSuggestion(
      { ...SINGLE, columns: cols("date", "content", "amount", "outflow") },
      4,
    );
    expect(half.ok && half.value.columns).toEqual({ date: 0, content: 1, amount: 2 });
    expect(half.ok && half.value.amountSign).toBe("outflow_positive");
  });

  it("出金・入金の対を採るとき amountSign は null にする", () => {
    const r = parseColumnSuggestion(
      { ...SINGLE, columns: cols("date", "content", "outflow", "inflow") },
      4,
    );
    expect(r.ok && r.value.amountSign).toBeNull();
  });
});
