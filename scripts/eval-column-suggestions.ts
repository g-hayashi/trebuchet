/**
 * 列の案の評価（007/R15、Constitution IV）。合成の例（`packages/domain/test/fixtures/statements/column-evals.ts`）を
 * 端末内の AI（`fm serve`）に尋ね、必須の役割がすべて正しい率・役割ごとの一致率・案なしの率を出す。
 * 結果（件数と割合だけ。見出し・値は出さない）を `.tmp/eval-columns/<日時>.json` に残し、前回の結果と比べて表示する。
 * プロンプト・`COLUMN_PROMPT_ROWS`・待ち時間（`COLUMN_TIMEOUT_MS`）を変えるときは、変更の前と後で実行して比べる。
 * CI では実行しない（AI を呼ぶ）。`fm` が使えなければ（Apple Intelligence が無効など）何も書かずに終了コード 1 で終わる。
 *
 *   pnpm eval:columns
 *   TREBUCHET_FM_PORT=18791 pnpm eval:columns   # `fm serve` のポート（既定 18790。server と同じ）
 *
 * `fm serve` は評価の間だけ起動し、終了時に必ず止める。実データ（`work/`・`data/`）は読まない。
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む（bench-statements.ts と同じ）。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLUMN_TIMEOUT_MS, createColumnProvider } from "../apps/server/src/lib/ai-client.ts";
import { LOCAL_AI_MODEL } from "../apps/server/src/lib/ai-runtime.ts";
import { createFmServer } from "../apps/server/src/lib/fm-server.ts";
import { COLUMN_PROMPT_ROWS } from "../packages/domain/src/statements/column-prompt.ts";
import {
  type ColumnEvalResult,
  evaluateColumnSuggestions,
} from "../packages/domain/src/usecases/statement-columns.ts";
import { COLUMN_EVAL_CASES } from "../packages/domain/test/fixtures/statements/column-evals.ts";
import { positiveNumber } from "./lib/bench-common.ts";

/** 保存する形（件数と千分率だけ） */
type SavedEval = ColumnEvalResult & {
  at: string;
  promptRows: number;
  timeoutMs: number;
};

const OUT_DIR = fileURLToPath(new URL("../.tmp/eval-columns/", import.meta.url));

/** 千分率を「87.5%」の形に */
const pct = (rate: number): string => `${(rate / 10).toFixed(1)}%`;

/** 前回との差（ポイント）。符号つき */
function delta(current: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const diff = (current - previous) / 10;
  return ` (前回比 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pt)`;
}

/** 前回の結果（日時つきのファイル名の最後）。なければ undefined。読めない・形が違うときも undefined */
function readPrevious(): SavedEval | undefined {
  let files: string[];
  try {
    files = readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return undefined;
  }
  const last = files.at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(readFileSync(`${OUT_DIR}${last}`, "utf8")) as SavedEval;
  } catch {
    return undefined;
  }
}

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

const fm = createFmServer({ port: positiveNumber("TREBUCHET_FM_PORT", 18790) });
try {
  if (!(await fm.available())) {
    console.error("端末内の AI（fm）が使えません。結果は残しません");
    process.exitCode = 1;
  } else {
    const provider = createColumnProvider({
      fetch: (...args) => globalThis.fetch(...args),
      available: () => fm.available(),
      localEndpoint: async () => {
        const baseUrl = await fm.ensureStarted();
        return baseUrl === undefined ? undefined : { baseUrl, model: LOCAL_AI_MODEL };
      },
    });
    const previous = readPrevious();
    const result = await evaluateColumnSuggestions(COLUMN_EVAL_CASES, provider);
    const saved: SavedEval = {
      at: new Date().toISOString(),
      promptRows: COLUMN_PROMPT_ROWS,
      timeoutMs: COLUMN_TIMEOUT_MS,
      ...result,
    };
    report(saved, previous);
    mkdirSync(OUT_DIR, { recursive: true });
    const file = `${OUT_DIR}${saved.at.replaceAll(":", "-").replaceAll(".", "-")}.json`;
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`  保存: ${file.slice(OUT_DIR.length)}（.tmp/eval-columns/）`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fm.stop();
}
