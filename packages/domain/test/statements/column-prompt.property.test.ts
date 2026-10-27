import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildColumnPrompt, COLUMN_PROMPT_ROWS } from "../../src/statements/column-prompt.ts";
import { detectTableLayout } from "../../src/statements/table.ts";

// 007 T016（R10、INV-48）。列の対応の案のプロンプトは、見出しのセルと先頭の明細の行 5 件だけを含み、
// 前置きの行と 6 行目以降の行の値を含まない。各セルに一意の印の文字列を入れた表を、実際の判定（detectTableLayout）に通す

const pad = (n: number) => String(n).padStart(3, "0");
const dateOf = (n: number) => `2026/04/${String((n % 28) + 1).padStart(2, "0")}`;

type Scenario = {
  preambleLines: number;
  withHeader: boolean;
  dataRows: number;
  eol: "\n" | "\r\n";
};

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  preambleLines: fc.integer({ min: 0, max: 3 }),
  withHeader: fc.boolean(),
  dataRows: fc.integer({ min: 7, max: 14 }),
  eol: fc.constantFrom("\n", "\r\n"),
});

/** 印は英字で挟んだ番号（部分一致で取り違えない）。日付・金額の列には印を入れない（値の形を保つ） */
const preMark = (i: number) => `ZPRE${pad(i)}Q`;
const headerMark = (c: number) => `ZHDR${pad(c)}Q`;
const cellMark = (r: number, c: number) => `ZROW${pad(r)}C${pad(c)}Q`;

function build(s: Scenario): { text: string; rowMarks: (row: number) => string[] } {
  const lines: string[] = [];
  for (let i = 0; i < s.preambleLines; i++) lines.push(preMark(i));
  if (s.withHeader) lines.push(["ZHDR000Q", "ZHDR001Q", "ZHDR002Q", "ZHDR003Q"].join("\t"));
  for (let r = 0; r < s.dataRows; r++) {
    lines.push([dateOf(r), cellMark(r, 1), String(1000 + r * 10), cellMark(r, 3)].join("\t"));
  }
  const rowMarks = (row: number) => [cellMark(row, 1), cellMark(row, 3)];
  return { text: `${lines.join(s.eol)}${s.eol}`, rowMarks };
}

describe("INV-48: buildColumnPrompt が含む範囲", () => {
  it("COLUMN_PROMPT_ROWS は 5", () => {
    expect(COLUMN_PROMPT_ROWS).toBe(5);
  });

  it("見出しと先頭 5 行は現れ、前置きと 6 行目以降は 1 つも現れない", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { text, rowMarks } = build(s);
        const detected = detectTableLayout(text);
        expect(detected.ok).toBe(true);
        if (!detected.ok) return;
        const layout = detected.value;
        expect(layout.header !== null).toBe(s.withHeader);

        const prompt = buildColumnPrompt(layout);
        const all = prompt.messages.map((m) => m.content).join("\n");

        for (let i = 0; i < s.preambleLines; i++) expect(all).not.toContain(preMark(i));
        if (s.withHeader) for (let c = 0; c < 4; c++) expect(all).toContain(headerMark(c));
        for (let r = 0; r < s.dataRows; r++) {
          for (const mark of rowMarks(r)) {
            if (r < COLUMN_PROMPT_ROWS) expect(all).toContain(mark);
            else expect(all).not.toContain(mark);
          }
        }
      }),
    );
  });
});
