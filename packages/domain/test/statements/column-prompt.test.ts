import { describe, expect, it } from "vitest";
import {
  buildColumnPrompt,
  hasRequiredColumns,
  parseColumnSuggestion,
} from "../../src/statements/column-prompt.ts";

// 007 T016（R10）。プロンプトの形と、AI の出力の検証（形・列の範囲・役割の重複・必須の役割）

const SPLIT = {
  columns: { date: 0, content: 1, outflow: 2, inflow: 3, memo: null },
  amountSign: null,
  confidence: 80,
  reason: "見出しから判断",
};
const SINGLE = {
  columns: { date: 0, content: 1, amount: 2 },
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
    expect(system).toContain("null");
    expect(system).toContain("amountSign");
    const user = prompt.messages[1]?.content ?? "";
    expect(user).toContain("コンビニ");
    expect(user).toContain("日付");
    expect(prompt.schema).toMatchObject({ type: "object", additionalProperties: false });
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
  it("出金・入金の 2 列。null の役割は落とし、amountSign は null になる", () => {
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
    expect(parseColumnSuggestion(JSON.stringify(SPLIT), 4).ok).toBe(true);
    expect(parseColumnSuggestion(`はい\n\`\`\`json\n${JSON.stringify(SINGLE)}\n\`\`\``, 3).ok).toBe(
      true,
    );
  });

  it("外れれば案なし", () => {
    const bad = (raw: unknown, columnCount = 4) => {
      const r = parseColumnSuggestion(raw, columnCount);
      expect(r.ok).toBe(false);
    };
    bad("JSON ではない");
    bad(null);
    bad({ ...SPLIT, columns: { date: "A" } });
    bad({ ...SPLIT, confidence: 101 });
    bad({ ...SPLIT, reason: "あ".repeat(201) });
    // 列の範囲（0〜columnCount-1）
    bad(SPLIT, 3);
    bad({ ...SPLIT, columns: { ...SPLIT.columns, date: -1 } });
    // 同じ列を 2 つの役割にしない
    bad({ ...SPLIT, columns: { ...SPLIT.columns, inflow: 2 } });
    // 必須の役割
    bad({ ...SPLIT, columns: { date: 0, content: 1, outflow: 2 } });
    bad({ ...SINGLE, columns: { date: 0, amount: 2 } });
    bad({ ...SINGLE, columns: { ...SINGLE.columns, content: null } });
    bad({ ...SINGLE, columns: { ...SINGLE.columns, outflow: 3 } });
  });
});
