/**
 * 明細の推定の評価（011/R10、Constitution IV）。合成の学習用/採点用明細だけを使い、
 * 本番のルール → 端末内 → 外部の経路を採点する。CIでは実行しない。
 *
 *   TREBUCHET_EVAL_AI_BASE_URL=<接続先> TREBUCHET_EVAL_AI_MODEL=<モデル> pnpm eval:statements
 *   TREBUCHET_EVAL_EXTERNAL_ENABLED=0 pnpm eval:statements  # 外部を明示的に無効にして評価
 *
 * 外部のキーはTREBUCHET_EVAL_AI_API_KEY、未指定なら既存キーチェーンのreadApiKeyを使う。
 * 外部有効時はURL・モデル・キーが必須。registryや実データ（work/・data/）は読まない。
 * fmのポートはTREBUCHET_FM_PORT（既定18791。本番18790とは別）。終了時finallyで止める。
 * fmが使えない・起動できない、設定不足、接続失敗は終了コード1で結果を保存しない。
 * 通信失敗は最初の1件で停止し、local/external・固定の失敗種別・HTTP番号だけを表示する。
 * 推定の前後はAI呼出の開始/完了件数を表示する（ルールだけの採点は含まない）。
 * 形の不正なAI出力は本番と同じく候補なしとして採点する。
 * .tmp/eval-statements/には件数・千分率・AI利用状態と最低限のmetadataだけを保存し前回比較する。
 * モデル名・URL・キー・明細・AIの回答や失敗の本文は表示も保存もしない。
 * プロンプトや推定経路を変える前後で実行する。異なる外部有効状態/fixture版は比較しない。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type AiEndpoint,
  createOpenAiProvider,
  EXTERNAL_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
} from "../apps/server/src/lib/ai-client.ts";
import { LOCAL_AI_MODEL, readApiKey } from "../apps/server/src/lib/ai-runtime.ts";
import { createFmServer } from "../apps/server/src/lib/fm-server.ts";
import { createKeychainSecretStore } from "../apps/server/src/lib/keychain.ts";
import {
  evaluateStatementScenes,
  type StatementSceneEvaluation,
} from "../packages/domain/src/statements/eval-runner.ts";
import { DEFAULT_STATEMENT_SETTINGS } from "../packages/domain/src/usecases/statements.ts";
import { JOURNAL_ENTRY_EVAL_CASES } from "../packages/domain/test/fixtures/statements/journal-entry-evals.ts";
import {
  STATEMENT_EVAL_ACCOUNTS,
  STATEMENT_EVAL_CASES,
  STATEMENT_EVAL_SPLIT_DATE,
} from "../packages/domain/test/fixtures/statements/statement-evals.ts";
import { isAllowedAiBaseUrl } from "../packages/schema/src/ai.ts";
import { positiveNumber } from "./lib/bench-common.ts";
import { createEvalProviderGuard, EvalProviderError } from "./lib/eval-provider.ts";

type SavedEval = StatementSceneEvaluation & {
  at: string;
  fixtureVersion: number;
  threshold: number;
};
const OUT_DIR = fileURLToPath(new URL("../.tmp/eval-statements/", import.meta.url));
const FIXTURE_VERSION = 1;
class EvalSetupError extends Error {}

async function loadEndpoint(): Promise<AiEndpoint | undefined> {
  const enabled = process.env.TREBUCHET_EVAL_EXTERNAL_ENABLED ?? "1";
  if (enabled === "0") return undefined;
  if (enabled !== "1")
    throw new EvalSetupError("TREBUCHET_EVAL_EXTERNAL_ENABLED は0か1を指定してください");
  const baseUrl = process.env.TREBUCHET_EVAL_AI_BASE_URL?.trim() ?? "";
  const model = process.env.TREBUCHET_EVAL_AI_MODEL?.trim() ?? "";
  if (baseUrl === "" || model === "") {
    throw new EvalSetupError("TREBUCHET_EVAL_AI_BASE_URL と TREBUCHET_EVAL_AI_MODEL が必要です");
  }
  if (
    !isAllowedAiBaseUrl(baseUrl) ||
    new URL(baseUrl).username !== "" ||
    new URL(baseUrl).password !== ""
  ) {
    throw new EvalSetupError(
      "接続先は認証情報を含まないhttps://かlocalhostのhttp://にしてください",
    );
  }
  const fromEnv = process.env.TREBUCHET_EVAL_AI_API_KEY;
  const apiKey =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : await readApiKey(createKeychainSecretStore());
  if (apiKey === undefined) throw new EvalSetupError("外部AIのAPIキーがありません");
  return { baseUrl, model, apiKey };
}

function readPrevious(): SavedEval | undefined {
  try {
    const last = readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .at(-1);
    if (last === undefined) return undefined;
    const saved = JSON.parse(readFileSync(`${OUT_DIR}${last}`, "utf8")) as SavedEval;
    return Array.isArray(saved.scenes) && saved.ai !== undefined ? saved : undefined;
  } catch {
    return undefined;
  }
}

const pct = (value: number) => `${(value / 10).toFixed(1)}%`;
function delta(value: number, previous: number | undefined): string {
  if (previous === undefined) return "";
  const diff = (value - previous) / 10;
  return `（前回比 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pt）`;
}

function report(saved: SavedEval, previous: SavedEval | undefined): void {
  const comparable =
    previous?.fixtureVersion === saved.fixtureVersion &&
    previous.threshold === saved.threshold &&
    previous.ai.externalEnabled === saved.ai.externalEnabled;
  console.log(`明細の推定の評価（外部AI ${saved.ai.externalEnabled ? "有効" : "無効"}）`);
  console.log(
    `  AI呼出: 端末内 ${saved.ai.localCalls} 件・外部 ${saved.ai.externalCalls} 件・接続失敗 ${saved.ai.failures} 件`,
  );
  for (const { scene, result } of saved.scenes) {
    const prev = comparable ? previous.scenes.find((s) => s.scene === scene)?.result : undefined;
    console.log(`  ${scene}: ${result.sampleCount} 件`);
    for (const field of ["counterAccount", "taxCategory", "partner", "purpose"] as const) {
      console.log(
        `    ${field}: ${pct(result.fields[field])}${delta(result.fields[field], prev?.fields[field])}`,
      );
    }
    for (const method of result.methods) {
      console.log(
        `    ${method.method}: ${method.count} 件・全項目一致 ${pct(method.matchRate)}${delta(method.matchRate, prev?.methods.find((m) => m.method === method.method)?.matchRate)}`,
      );
    }
  }
  console.log(
    previous === undefined
      ? "  前回の結果: なし"
      : comparable
        ? "  前回の結果と比較しました"
        : "  前回の結果: 評価条件が異なるため比較しません",
  );
}

const fm = createFmServer({ port: positiveNumber("TREBUCHET_FM_PORT", 18791) });
try {
  const endpoint = await loadEndpoint();
  const baseUrl = await fm.ensureStarted();
  if (baseUrl === undefined) throw new EvalSetupError("端末内AI（fm）が使えないか起動できません");
  const local = createOpenAiProvider({
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: LOCAL_TIMEOUT_MS,
    responseFormat: false,
    available: () => fm.available(),
    endpoint: async () => ({ baseUrl, model: LOCAL_AI_MODEL }),
  });
  const external = createOpenAiProvider({
    fetch: (...args) => globalThis.fetch(...args),
    timeoutMs: EXTERNAL_TIMEOUT_MS,
    available: async () => endpoint !== undefined,
    endpoint: async () => endpoint,
  });
  const threshold = DEFAULT_STATEMENT_SETTINGS.externalThreshold;
  const guard = createEvalProviderGuard((phase, count) => {
    console.log(phase === "started" ? `  AI推定開始: ${count} 件目` : `  AI推定完了: ${count} 件`);
  });
  console.log(
    "合成の明細と仕訳の入力（journal_entry）を1件ずつ推定します（端末内AIと、有効なら外部AIに送信）",
  );
  const result = await evaluateStatementScenes(
    // 明細の場面（statement）の集計は、journal_entry を足しても変わらない（場面ごとに別に数える）
    [...STATEMENT_EVAL_CASES, ...JOURNAL_ENTRY_EVAL_CASES],
    {
      local: guard(local, "local"),
      external: guard(external, "external"),
      externalEnabled: endpoint !== undefined,
      models: { local: LOCAL_AI_MODEL, external: endpoint?.model ?? "" },
    },
    { ledgerAccounts: STATEMENT_EVAL_ACCOUNTS, splitDate: STATEMENT_EVAL_SPLIT_DATE, threshold },
  );
  if (
    result.ai.failures > 0 ||
    result.ai.localUnavailable > 0 ||
    result.ai.externalUnavailable > 0 ||
    result.ai.localCalls === 0
  ) {
    throw new EvalSetupError("AIが利用できないか接続に失敗しました。評価結果は保存しません");
  }
  const saved: SavedEval = {
    at: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    threshold,
    ...result,
  };
  report(saved, readPrevious());
  mkdirSync(OUT_DIR, { recursive: true });
  const name = `${saved.at.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  writeFileSync(`${OUT_DIR}${name}`, `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`  保存: .tmp/eval-statements/${name}`);
} catch (error) {
  console.error(
    error instanceof EvalSetupError || error instanceof EvalProviderError
      ? error.message
      : "評価に失敗しました（結果は残しません）",
  );
  process.exitCode = 1;
} finally {
  fm.stop();
}
