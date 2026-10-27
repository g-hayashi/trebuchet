import {
  AiColumnSuggestion,
  STATEMENT_AMOUNT_SIGNS,
  STATEMENT_COLUMN_ROLES,
  type StatementAmountSign,
  type StatementColumnIndexes,
  type StatementColumnRole,
} from "@trebuchet/schema";
import { ok, type Result, validation } from "../types.ts";
import { readAiJson } from "./prompt.ts";

// 端末内の AI による列の対応の案のための要求と出力の検証（007/R10、INV-48）。呼び出し（HTTP）はドメインの外

/** プロンプトに入れる明細の行の数（見出しの次から数える。変えるときは `pnpm eval:columns` で前後を比べる。R15） */
export const COLUMN_PROMPT_ROWS = 5;

/**
 * 要求（Chat Completions の messages と、`response_format` の json_schema に使う schema）。
 * server の provider がそのまま流せる形
 */
export type ColumnPrompt = {
  messages: { role: "system" | "user"; content: string }[];
  schema: object;
};

/** `buildColumnPrompt` が読む表の形（`StatementTableLayout` の一部） */
export type ColumnPromptLayout = {
  header: readonly string[] | null;
  sampleRows: readonly (readonly string[])[];
  columnCount: number;
};

/** 検証を通った案。`columns` に null の役割は入らない */
export type ColumnSuggestion = {
  columns: StatementColumnIndexes;
  amountSign: StatementAmountSign | null;
  confidence: number;
  reason: string;
};

const SYSTEM = [
  "あなたは日本の銀行・クレジットカード・家計簿アプリの明細の表を読みます。",
  "与えられた表の見出しと先頭の数行から、各列がどの役割かを推定してください。",
  "",
  "役割の一覧:",
  "- date: 取引の日付",
  "- content: 取引の内容・摘要・利用店名",
  "- amount: 金額が 1 列にまとまっている列（入金と出金が符号で分かれる）",
  "- outflow: 出金（支払）の金額の列。inflow とともに使う",
  "- inflow: 入金の金額の列。outflow とともに使う",
  "- accountName: 口座・カードの名前",
  "- categoryMajor: 大項目（分類）",
  "- categoryMinor: 中項目（分類）",
  "- memo: メモ・備考",
  "- externalId: 取引の ID",
  "- transferFlag: 振替かどうかの印",
  "",
  "入力は JSON です。columns の index は列の番号（0 起点）、header は見出し（見出しがない表では null）、",
  "samples はその列の先頭の数行の値です。残高の列はどの役割にも当てないでください。",
  "",
  "出力は次の形の JSON オブジェクトだけにしてください（前後に文章を付けない）:",
  '{"columns": {"date": 列の番号か null, "content": ..., "amount": ..., "outflow": ..., "inflow": ...,',
  ' "accountName": ..., "categoryMajor": ..., "categoryMinor": ..., "memo": ..., "externalId": ...,',
  ' "transferFlag": ...}, "amountSign": "inflow_positive" か "outflow_positive" か null,',
  ' "confidence": 0〜100 の整数, "reason": 根拠を 200 字以内で}',
  "列の番号は 0 起点です。該当する列がない役割・分からない役割は null にしてください。",
  "同じ列を 2 つの役割に当てないでください。",
  "amount が 1 列のときだけ、入金が正の数なら inflow_positive、出金（支払）が正の数なら outflow_positive と",
  "推測してかまいません（分からなければ null）。amount を使わないとき（outflow と inflow を使うとき）は null にします。",
].join("\n");

const nullableIndex = { anyOf: [{ type: "integer" }, { type: "null" }] };

/** `response_format` の json_schema 用（strict。受けない接続先もあるので、出力は必ず `parseColumnSuggestion` で検証する） */
const SCHEMA = {
  type: "object",
  properties: {
    columns: {
      type: "object",
      properties: Object.fromEntries(STATEMENT_COLUMN_ROLES.map((role) => [role, nullableIndex])),
      required: [...STATEMENT_COLUMN_ROLES],
      additionalProperties: false,
    },
    amountSign: {
      anyOf: [{ type: "string", enum: [...STATEMENT_AMOUNT_SIGNS] }, { type: "null" }],
    },
    confidence: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["columns", "amountSign", "confidence", "reason"],
  additionalProperties: false,
} as const;

/**
 * 要求を作る（INV-48）。入れるのは見出しのセルと、見出しの次から `COLUMN_PROMPT_ROWS` 行の値だけ。
 * 見出しより前の行（前置き）と、それより後ろの行は入れない。値は伏せない（端末内の AI だけに送る。R10）。
 * `sampleRows` は見出しより後の行なので、前置きは含まれない。見出しのない表では前置きの行も `sampleRows` に入るので、
 * 列数が表の列数と違う行（前置きの行）は数えずに飛ばす
 */
export function buildColumnPrompt(layout: ColumnPromptLayout): ColumnPrompt {
  const rows = layout.sampleRows
    .filter((row) => row.length === layout.columnCount)
    .slice(0, COLUMN_PROMPT_ROWS);
  const columns = Array.from({ length: layout.columnCount }, (_, index) => ({
    index,
    header: layout.header?.[index] ?? null,
    samples: rows.map((row) => row[index] ?? ""),
  }));
  const user = JSON.stringify({ columnCount: layout.columnCount, columns });
  return {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    schema: SCHEMA,
  };
}

/**
 * 日付・内容と、金額（1 列）か出金・入金（2 列）の一方がそろっているか
 * （`StatementColumnMapping` の検査と同じ。金額と出金・入金の両方は不可）
 */
export function hasRequiredColumns(columns: StatementColumnIndexes): boolean {
  if (columns.date === undefined || columns.content === undefined) return false;
  const hasAmount = columns.amount !== undefined;
  const hasOutflow = columns.outflow !== undefined;
  const hasInflow = columns.inflow !== undefined;
  return (hasAmount && !hasOutflow && !hasInflow) || (!hasAmount && hasOutflow && hasInflow);
}

/**
 * AI の出力を検証する（INV-48 の出力側）。`AiColumnSuggestion`（Zod）の形で、列の番号が 0〜`columnCount`−1、
 * 同じ列を 2 つの役割にせず、必須の役割がそろうものだけを通す。外れれば失敗（案なし）。
 * `raw` は JSON の文字列でも、読み取り済みの値でもよい
 */
export function parseColumnSuggestion(raw: unknown, columnCount: number): Result<ColumnSuggestion> {
  const value = typeof raw === "string" ? readAiJson(raw) : raw;
  if (value === undefined) return validation("AI の出力を JSON として読めません");
  const parsed = AiColumnSuggestion.safeParse(value);
  if (!parsed.success) return validation("AI の出力が決められた形ではありません");

  const columns: StatementColumnIndexes = {};
  const used = new Set<number>();
  for (const role of Object.keys(parsed.data.columns) as StatementColumnRole[]) {
    const index = parsed.data.columns[role];
    if (index === null || index === undefined) continue;
    if (index >= columnCount) {
      return validation("AI の出力の列の番号が表の範囲を超えています", { field: role });
    }
    if (used.has(index)) {
      return validation("AI の出力が同じ列を 2 つの役割に当てています", { field: role });
    }
    used.add(index);
    columns[role] = index;
  }
  if (!hasRequiredColumns(columns)) {
    return validation("AI の出力に必須の役割（日付・内容・金額か出金と入金）がそろっていません");
  }
  return ok({
    columns,
    amountSign: parsed.data.amountSign ?? null,
    confidence: parsed.data.confidence,
    reason: parsed.data.reason,
  });
}
