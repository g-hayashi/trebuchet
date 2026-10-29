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

/** 検証を通った案。`columns` に null の役割は入らない（理由は AI に書かせない） */
export type ColumnSuggestion = {
  columns: StatementColumnIndexes;
  amountSign: StatementAmountSign | null;
  confidence: number;
};

// 出力を短くするため（端末内のモデルは出力の長さで遅くなる。T022）、指示は短く、理由・列の番号は書かせない
const SYSTEM = [
  "日本の銀行・カード・家計簿アプリの明細の表です。入力 JSON の columns を列の順に見て、各列の役割を 1 つ選びます。",
  "date: 日付 / content: 内容・摘要・店名 / amount: 金額 1 列（符号で入出金）",
  "outflow: 出金の金額 / inflow: 入金の金額 / accountName: 口座・カード名",
  "categoryMajor: 大項目 / categoryMinor: 中項目 / memo: メモ / externalId: 取引の ID / transferFlag: 振替の印",
  "none: 上のどれでもない・分からない（残高も none）",
  "同じ役割は 1 列だけ。出力は JSON だけ。roles は列の数だけ、列の順:",
  '{"roles": ["date", "content", "none"], "amountSign": null, "confidence": 80}',
  "amountSign は amount があるときだけ、入金が正なら inflow_positive、出金が正なら outflow_positive（不明は null）。",
].join("\n");

/**
 * `response_format` の json_schema 用（strict。受けない接続先もあるので、出力は必ず `parseColumnSuggestion` で検証する）。
 * roles の長さは列数に固定する（長さの違いで案なしになるのを、生成の側で防ぐ）
 */
function schemaOf(columnCount: number) {
  return {
    type: "object",
    properties: {
      roles: {
        type: "array",
        items: { type: "string", enum: [...STATEMENT_COLUMN_ROLES, "none"] },
        minItems: columnCount,
        maxItems: columnCount,
      },
      amountSign: {
        anyOf: [{ type: "string", enum: [...STATEMENT_AMOUNT_SIGNS] }, { type: "null" }],
      },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["roles", "amountSign", "confidence"],
    additionalProperties: false,
  } as const;
}

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
    schema: schemaOf(layout.columnCount),
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
 * AI の出力を検証する（INV-48 の出力側）。`AiColumnSuggestion`（Zod。`roles` は列の順に役割 1 つずつ）の形で、
 * `roles` の長さが `columnCount` と等しく、整えた後に必須の役割がそろうものだけを通す。外れれば失敗（案なし）。
 * 整え方（端末内のモデルは誤りやすいので、救える分は救う。R10）:
 * - 同じ役割が複数の列に付いたら、その役割だけ捨てる（ほかの役割は残す）
 * - 金額と出金・入金の対がともにあれば、出金・入金の対を採り金額を捨てる。出金・入金の片方だけなら、金額を採りその片方を捨てる
 * - 金額を採らないとき `amountSign` は null にする
 * `raw` は JSON の文字列でも、読み取り済みの値でもよい
 */
export function parseColumnSuggestion(raw: unknown, columnCount: number): Result<ColumnSuggestion> {
  const value = typeof raw === "string" ? readAiJson(raw) : raw;
  if (value === undefined) return validation("AI の出力を JSON として読めません");
  const parsed = AiColumnSuggestion.safeParse(value);
  if (!parsed.success) return validation("AI の出力が決められた形ではありません");

  if (parsed.data.roles.length !== columnCount) {
    return validation("AI の出力の役割の数が表の列数と違います", { field: "roles" });
  }
  const byRole = new Map<StatementColumnRole, number[]>();
  for (const [index, role] of parsed.data.roles.entries()) {
    if (role === "none") continue;
    byRole.set(role, [...(byRole.get(role) ?? []), index]);
  }
  // 複数の列に付いた役割は捨てる
  const columns: StatementColumnIndexes = {};
  for (const [role, indexes] of byRole) {
    const [only] = indexes;
    if (indexes.length === 1 && only !== undefined) columns[role] = only;
  }
  // 金額と出金・入金: 対がそろえば対を採り、片方だけなら金額を採る
  if (columns.amount !== undefined) {
    if (columns.outflow !== undefined && columns.inflow !== undefined) {
      delete columns.amount;
    } else {
      delete columns.outflow;
      delete columns.inflow;
    }
  }
  if (!hasRequiredColumns(columns)) {
    return validation("AI の出力に必須の役割（日付・内容・金額か出金と入金）がそろっていません");
  }
  return ok({
    columns,
    amountSign: columns.amount === undefined ? null : (parsed.data.amountSign ?? null),
    confidence: parsed.data.confidence,
  });
}
