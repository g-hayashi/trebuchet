/**
 * 列の案の評価（007/R15、Constitution IV）。合成の例（`packages/domain/test/fixtures/statements/column-evals.ts`）を
 * 端末内の AI（`fm serve`）に尋ね、必須の役割がすべて正しい率・役割ごとの一致率・案なしの率を出す。
 * 結果（件数と割合だけ。見出し・値は出さない）を `.tmp/eval-columns/<日時>.json` に残し、前回の結果と比べて表示する。
 * プロンプト・`COLUMN_PROMPT_ROWS`・待ち時間（`COLUMN_TIMEOUT_MS`）を変えるときは、変更の前と後で実行して比べる。
 * CI では実行しない（AI を呼ぶ）。`fm` が使えなければ（Apple Intelligence が無効など）何も書かずに終了コード 1 で終わる。
 *
 *   pnpm eval:columns
 *   TREBUCHET_FM_PORT=18792 pnpm eval:columns   # `fm serve` のポート（既定 18791。server の 18790 と分け、`pnpm dev` 中でも衝突しない）
 *
 * `fm serve` は評価の間だけ起動し、終了時に必ず止める。実データ（`work/`・`data/`）は読まない。
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む（bench-statements.ts と同じ）。
 */
import { COLUMN_TIMEOUT_MS, createColumnProvider } from "../apps/server/src/lib/ai-client.ts";
import { LOCAL_AI_MODEL } from "../apps/server/src/lib/ai-runtime.ts";
import { createFmServer } from "../apps/server/src/lib/fm-server.ts";
import { COLUMN_PROMPT_ROWS } from "../packages/domain/src/statements/column-prompt.ts";
import {
  type ColumnEvalResult,
  evaluateColumnSuggestions,
} from "../packages/domain/src/usecases/statement-columns.ts";
import { COLUMN_EVAL_CASES } from "../packages/domain/test/fixtures/statements/column-evals.ts";
import { evalFmPort } from "./lib/env.ts";
import { delta, evalDir, evalFetch, pct, readPrevious, saveEval } from "./lib/eval-history.ts";

/** 保存する形（件数と千分率だけ） */
type SavedEval = ColumnEvalResult & {
  at: string;
  promptRows: number;
  timeoutMs: number;
};

const OUT_DIR = evalDir("eval-columns");

function report(current: SavedEval, previous: SavedEval | undefined): void {
  const prevRole = (role: string) => previous?.roles.find((r) => r.role === role)?.matchRate;
  console.log(
    `列の案の評価: ${current.caseCount} 件（端末内の AI。プロンプトの行数 ${current.promptRows}）`,
  );
  console.log(
    `  必須の役割がすべて正しい: ${pct(current.allRequiredRate)}${delta(current.allRequiredRate, previous?.allRequiredRate)}`,
  );
  console.log(
    `  案なし: ${pct(current.noSuggestionRate)}${delta(current.noSuggestionRate, previous?.noSuggestionRate)}` +
      `（使えない ${current.unavailable.unavailable}・時間切れ ${current.unavailable.timeout}・形の誤り ${current.unavailable.invalid}）`,
  );
  for (const r of current.roles) {
    console.log(
      `  ${r.role}: ${pct(r.matchRate)}（${r.count} 件）${delta(r.matchRate, prevRole(r.role))}`,
    );
  }
  console.log(
    `  amountSign: ${pct(current.amountSign.matchRate)}（${current.amountSign.count} 件）${delta(current.amountSign.matchRate, previous?.amountSign.matchRate)}`,
  );
  console.log(previous === undefined ? "  前回の結果: なし" : `  前回の結果: ${previous.at}`);
}

const fm = createFmServer({ port: evalFmPort() });
try {
  if (!(await fm.available())) {
    console.error("端末内の AI（fm）が使えません。結果は残しません");
    process.exitCode = 1;
  } else {
    const provider = createColumnProvider({
      fetch: evalFetch,
      available: () => fm.available(),
      localEndpoint: async () => {
        const baseUrl = await fm.ensureStarted();
        return baseUrl === undefined ? undefined : { baseUrl, model: LOCAL_AI_MODEL };
      },
    });
    const previous = readPrevious<SavedEval>(OUT_DIR);
    const result = await evaluateColumnSuggestions(COLUMN_EVAL_CASES, provider);
    const saved: SavedEval = {
      at: new Date().toISOString(),
      promptRows: COLUMN_PROMPT_ROWS,
      timeoutMs: COLUMN_TIMEOUT_MS,
      ...result,
    };
    report(saved, previous);
    console.log(`  保存: ${saveEval(OUT_DIR, saved)}（.tmp/eval-columns/）`);
  }
} catch {
  // 例外の中身（URL・応答の本文を含みうる）は出さない
  console.error("評価に失敗しました（結果は残しません）");
  process.exitCode = 1;
} finally {
  fm.stop();
}
