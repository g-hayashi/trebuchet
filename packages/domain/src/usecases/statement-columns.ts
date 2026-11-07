import {
  STATEMENT_COLUMN_ROLES,
  type StatementAmountSign,
  type StatementColumnIndexes,
  type StatementColumnRole,
  type StatementTableLayout,
} from "@trebuchet/schema";
import type { ColumnSuggestionProvider } from "../ports.ts";
import { dropMismatchedColumns, inferMissingColumns } from "../statements/column-content.ts";
import {
  buildColumnPrompt,
  type ColumnSuggestion,
  hasRequiredColumns,
  parseColumnSuggestion,
} from "../statements/column-prompt.ts";
import { suggestAmountSign } from "../statements/columns.ts";
import { perMille } from "../statements/evals.ts";

// 端末内の AI による列の対応の案（007/R10、FR-016・FR-018、contracts §4.1）。値は帳簿に書かない（案を返すだけ）

/** provider が時間切れの失敗に付ける details。ユースケースはこれで `timeout` と他の失敗を見分ける */
export const COLUMN_TIMEOUT_DETAIL = { timeout: true } as const;

/** 案を作れなかった理由。`disabled` は AI の設定で端末内が無効（provider を渡さない） */
export type ColumnSuggestionUnavailable = "disabled" | "unavailable" | "timeout" | "invalid";

export type ColumnSuggestionResult = {
  suggestion: ColumnSuggestion | null;
  /**
   * AI の案がないときだけ付く。AI を呼ぶ必要がなかったとき（辞書の案か保存した対応で足りる）は付かない。
   * 案（`suggestion`）と一緒に付くときは、AI を使えず、列の中身から推定しただけの案（`confidence` は 0。R16）
   */
  unavailable?: ColumnSuggestionUnavailable;
};

export type ColumnSuggestionDeps = {
  /** 端末内の AI。設定で無効なら渡さない（undefined） */
  provider: ColumnSuggestionProvider | undefined;
};

/** `suggestStatementColumns` が読む表の形（`detectStatementLayout` の戻りの一部） */
export type ColumnSuggestionLayout = Pick<
  StatementTableLayout,
  "header" | "sampleRows" | "columnCount" | "suggestedColumns" | "match"
>;

const none = (unavailable: ColumnSuggestionUnavailable): ColumnSuggestionResult => ({
  suggestion: null,
  unavailable,
});

/**
 * 列の案を AI に尋ねる。保存した取込元が当てはまる（`match` が none でない）か、辞書の案で必須の役割が
 * そろうときは呼ばず、案なしで返す（`unavailable` は付けない）。使えない・時間切れ・形の誤りは、案なしと理由で返す。
 * 渡すのは `buildColumnPrompt` の結果だけ（INV-48）
 */
export async function suggestStatementColumns(
  deps: ColumnSuggestionDeps,
  layout: ColumnSuggestionLayout,
): Promise<ColumnSuggestionResult> {
  if (layout.match.kind !== "none" || hasRequiredColumns(layout.suggestedColumns)) {
    return { suggestion: null };
  }
  const { provider } = deps;
  if (provider === undefined) return contentOnly(layout, "disabled");

  let response: Awaited<ReturnType<ColumnSuggestionProvider["suggestColumns"]>>;
  try {
    if (!(await provider.available())) return contentOnly(layout, "unavailable");
    response = await provider.suggestColumns(buildColumnPrompt(layout));
  } catch {
    return contentOnly(layout, "unavailable");
  }
  if (!response.ok) {
    return contentOnly(
      layout,
      response.error.details?.timeout === true ? "timeout" : "unavailable",
    );
  }
  const parsed = parseColumnSuggestion(response.value, layout.columnCount);
  if (!parsed.ok) return contentOnly(layout, "invalid");
  const checked = checkAgainstSamples(parsed.value, layout);
  return checked === null ? contentOnly(layout, "invalid") : { suggestion: checked };
}

/** 見本の行は列数が表と同じ行だけ（前置きなどの幅が違う行は除く。なければ全部） */
function sampleRowsOf(layout: ColumnSuggestionLayout): string[][] {
  const sameWidth = layout.sampleRows.filter((row) => row.length === layout.columnCount);
  return sameWidth.length > 0 ? sameWidth : layout.sampleRows;
}

/**
 * AI を呼ばない・使えない・失敗したときの案: 辞書の案にない日付・金額・内容だけを、列の中身から推定して返す（007/R16）。
 * 辞書の案は変えない（辞書の列・役割は取らない）。AI の案ではないので、`confidence` は 0 で、`unavailable`（AI を使えなかった理由）を
 * 付けたまま返す。画面は、案と `unavailable` が両方あれば「中身からの推定」と示す。推定できる列がなければ案なし
 */
function contentOnly(
  layout: ColumnSuggestionLayout,
  reason: ColumnSuggestionUnavailable,
): ColumnSuggestionResult {
  const columns = inferMissingColumns(
    layout.suggestedColumns,
    sampleRowsOf(layout),
    layout.columnCount,
  );
  if (Object.keys(columns).length === 0) return none(reason);
  const sign =
    columns.amount === undefined ? undefined : suggestAmountSign(layout.header, columns.amount);
  return {
    suggestion: { columns, amountSign: sign ?? null, confidence: 0 },
    unavailable: reason,
  };
}

/** 役割を「別の役割の列は取らない」ことで守る列（中身から推定した列に、これ以外の役割の列は譲る） */
const KEPT_ROLES: readonly StatementColumnRole[] = [
  "date",
  "content",
  "amount",
  "outflow",
  "inflow",
];

/**
 * AI の案を、見本の行の値で確かめる（007/R16。AI のプロンプトは変えない）。
 * 1. 値と合わない役割（日付が日付でない、金額が金額でない）を捨てる（`dropMismatchedColumns`）
 * 2. 辞書の案にも AI の案にもない日付・金額（1 列のとき）・内容を、中身から推定して足す（`inferMissingColumns`）。
 *    推定した列に付いていた、日付・内容・金額・出金・入金以外の役割（大項目など）は外す
 * 3. 符号の案: 金額の列の見出しがカードの利用額なら出金が正（AI の案より優先）。そうでなければ、AI が選んだ金額の列のときだけ AI の案
 * 見本の行は列数が表と同じ行だけ（前置きなどの幅が違う行は除く。なければ全部）。何も残らなければ null
 */
function checkAgainstSamples(
  suggestion: ColumnSuggestion,
  layout: ColumnSuggestionLayout,
): ColumnSuggestion | null {
  const rows = sampleRowsOf(layout);
  const kept = dropMismatchedColumns(suggestion.columns, rows);
  const inferred = inferMissingColumns(
    { ...layout.suggestedColumns, ...kept },
    rows,
    layout.columnCount,
  );
  const taken = new Set(Object.values(inferred));
  const columns: StatementColumnIndexes = {};
  for (const [role, index] of Object.entries(kept) as [StatementColumnRole, number][]) {
    if (KEPT_ROLES.includes(role) || !taken.has(index)) columns[role] = index;
  }
  Object.assign(columns, inferred);
  if (Object.keys(columns).length === 0) return null;

  let amountSign: StatementAmountSign | null = null;
  if (columns.amount !== undefined) {
    const fromAi = kept.amount === columns.amount ? suggestion.amountSign : null;
    amountSign = suggestAmountSign(layout.header, columns.amount) ?? fromAi;
  }
  return { columns, amountSign, confidence: suggestion.confidence };
}

// 列の案の評価（007/R15、Constitution IV）。合成の例で、案の精度を前後で比べる。純関数（AI は provider で受け取る）

/** 評価の 1 例。`expected` は正しい対応（`amountSign` は金額 1 列で向きが決まる例だけ） */
export type ColumnEvalCase = {
  /** 例の名前（結果には出さない。テストの表示用） */
  name: string;
  header: string[] | null;
  sampleRows: string[][];
  columnCount: number;
  expected: { columns: StatementColumnIndexes; amountSign?: StatementAmountSign };
};

/** 率は千分率の整数（0〜1000）。件数 0 のときは 0 */
export type ColumnEvalResult = {
  caseCount: number;
  /** 必須の役割（日付・内容・金額か出金・入金）がすべて正しい例の率 */
  allRequiredRate: number;
  /** 案なし（理由を問わない）の例の率 */
  noSuggestionRate: number;
  /** 案なしの理由別の件数 */
  unavailable: Record<ColumnSuggestionUnavailable, number>;
  /** 正解に含まれる役割だけ（件数 1 以上）。`matchRate` は、その役割を持つ例のうち、案の列が正解と同じ率（案なしは不一致） */
  roles: { role: StatementColumnRole; count: number; matchRate: number }[];
  /** 正解に `amountSign` がある例の件数と、案の向きが同じ率 */
  amountSign: { count: number; matchRate: number };
};

const REQUIRED_ROLES: readonly StatementColumnRole[] = [
  "date",
  "content",
  "amount",
  "outflow",
  "inflow",
];

/**
 * 例ごとに `suggestStatementColumns` と同じ経路で案を作り、正解と比べる。評価では必ず AI に尋ねるので、
 * 辞書の案は空、保存した取込元は当てはまらない（none）として渡す。例は 1 件ずつ順に呼ぶ（端末内の AI は同時に 1 つ）。
 * 出力は件数と率だけ（見出し・値は含めない）
 */
export async function evaluateColumnSuggestions(
  cases: readonly ColumnEvalCase[],
  provider: ColumnSuggestionProvider | undefined,
): Promise<ColumnEvalResult> {
  const unavailable: Record<ColumnSuggestionUnavailable, number> = {
    disabled: 0,
    unavailable: 0,
    timeout: 0,
    invalid: 0,
  };
  const roleCounts = new Map<StatementColumnRole, { count: number; matched: number }>();
  let allRequired = 0;
  let noSuggestion = 0;
  let signCount = 0;
  let signMatched = 0;

  for (const c of cases) {
    const { suggestion: answer, unavailable: reason } = await suggestStatementColumns(
      { provider },
      {
        header: c.header,
        sampleRows: c.sampleRows,
        columnCount: c.columnCount,
        suggestedColumns: {},
        match: { kind: "none" },
      },
    );
    // 理由（unavailable）つきの案は、AI の案ではなく中身からの推定なので、評価では案なしに数える
    const suggestion = reason === undefined ? answer : null;
    if (suggestion === null) {
      noSuggestion += 1;
      if (reason !== undefined) unavailable[reason] += 1;
    }
    const got = suggestion?.columns ?? {};
    for (const role of STATEMENT_COLUMN_ROLES) {
      const want = c.expected.columns[role];
      if (want === undefined) continue;
      const entry = roleCounts.get(role) ?? { count: 0, matched: 0 };
      entry.count += 1;
      if (got[role] === want) entry.matched += 1;
      roleCounts.set(role, entry);
    }
    if (
      suggestion !== null &&
      REQUIRED_ROLES.every((role) => got[role] === c.expected.columns[role])
    ) {
      allRequired += 1;
    }
    if (c.expected.amountSign !== undefined) {
      signCount += 1;
      if (suggestion?.amountSign === c.expected.amountSign) signMatched += 1;
    }
  }

  return {
    caseCount: cases.length,
    allRequiredRate: perMille(allRequired, cases.length),
    noSuggestionRate: perMille(noSuggestion, cases.length),
    unavailable,
    roles: STATEMENT_COLUMN_ROLES.flatMap((role) => {
      const entry = roleCounts.get(role);
      return entry === undefined
        ? []
        : [{ role, count: entry.count, matchRate: perMille(entry.matched, entry.count) }];
    }),
    amountSign: { count: signCount, matchRate: perMille(signMatched, signCount) },
  };
}
