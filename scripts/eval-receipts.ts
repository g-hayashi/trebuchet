/**
 * 証憑の読み取りの評価（010/R17、Constitution IV）。合成の画像（`packages/domain/test/fixtures/receipts/eval/`）を、
 * 本番と同じ経路（`toAiJpeg`〔sips〕→ `stripJpegMetadata` → `buildReceiptReadingRequest` → `createReceiptReader`）で
 * **外部の AI** に送り、項目ごとの一致率（取引年月日・金額・取引先・科目・税区分）と失敗の件数を出す。
 * 目標: 取引年月日・金額が 90% 以上（20 枚中 18 枚）。取引先・科目・税区分は記録だけ。
 * 結果（件数と割合だけ。ファイル名・取引先・値は出さない）を `.tmp/eval-receipts/<日時>.json` に残し、前回と比べて表示する。
 * 指示文・`RECEIPT_AI_MAX_PX`・`RECEIPT_READ_TIMEOUT_MS` を変えるときは、変更の前と後で実行して比べる。
 * CI では実行しない（画像を外部に送る。費用がかかる。sips が要る）。
 *
 *   TREBUCHET_EVAL_AI_BASE_URL=https://… TREBUCHET_EVAL_AI_MODEL=… pnpm eval:receipts
 *
 * 環境変数（接続先の設定は暗号化した registry にあり、このスクリプトは開かないので、ここで渡す）:
 *   TREBUCHET_EVAL_AI_BASE_URL  必須。外部の AI の URL（`https://` か localhost の `http://`）
 *   TREBUCHET_EVAL_AI_MODEL     必須。画像入力に対応するモデル名
 *   TREBUCHET_EVAL_AI_API_KEY   API キー。なければ 006 と同じキーチェーン（設定画面で保存したキー）から読む。
 *                               キーは出力・ファイルに書かない。localhost の接続先ならキーなしでもよい
 *
 * 画像は `eval/` の下に置き（用意は 010/T042）、正解は `fixtures/receipts/expected.ts` に同じファイル名で書く。
 * 画像がない・正解と食い違うときは、AI を呼ばずに終了コード 1 で止まる。実データ（`work/`・`data/`）は読まない。
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む（eval-column-suggestions.ts と同じ）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReceiptReader, RECEIPT_READ_TIMEOUT_MS } from "../apps/server/src/lib/ai-client.ts";
import { readApiKey } from "../apps/server/src/lib/ai-runtime.ts";
import { createImageTool } from "../apps/server/src/lib/image-tool.ts";
import { createKeychainSecretStore } from "../apps/server/src/lib/keychain.ts";
import { TMP_ROOT } from "../packages/db/src/tenant-store.ts";
import {
  evaluateReceiptReadings,
  RECEIPT_EVAL_FIELDS,
  type ReceiptEvalCase,
  type ReceiptEvalResult,
  receiptEvalTargets,
} from "../packages/domain/src/receipts/evals.ts";
import { detectReceiptFormat } from "../packages/domain/src/receipts/format.ts";
import { RECEIPT_AI_MAX_PX } from "../packages/domain/src/receipts/reading-prompt.ts";
import { INDIVIDUAL_ACCOUNTS } from "../packages/domain/src/seed/accounts.individual.ts";
import { counterAccounts } from "../packages/domain/src/statements/prompt.ts";
import { RECEIPT_EVAL_EXPECTED } from "../packages/domain/test/fixtures/receipts/expected.ts";
import { isAllowedAiBaseUrl, TaxCategoryCode } from "../packages/schema/src/index.ts";
import { delta, evalDir, evalFetch, pct, readPrevious, saveEval } from "./lib/eval-history.ts";

/** 保存する形（件数と千分率だけ。モデル名・URL・キーは残さない） */
type SavedEval = ReceiptEvalResult & {
  at: string;
  maxPx: number;
  timeoutMs: number;
};

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const IMAGE_DIR = `${ROOT}packages/domain/test/fixtures/receipts/eval/`;
const OUT_DIR = evalDir("eval-receipts");
const IMAGE_FILE = /\.(jpe?g|png|heic|pdf)$/i;

/** 停止の理由を出して終了コード 1 にする（AI は呼ばない・何も保存しない） */
class EvalSetupError extends Error {}

/** `eval/` の画像と `expected.ts` の正解から例を作る。画像がない・食い違いは `EvalSetupError` */
function loadCases(): ReceiptEvalCase[] {
  let files: string[];
  try {
    files = readdirSync(IMAGE_DIR)
      .filter((f) => IMAGE_FILE.test(f))
      .sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    throw new EvalSetupError(
      "評価用の画像がありません（packages/domain/test/fixtures/receipts/eval/）。合成の画像 20 枚の用意は 010/T042 です",
    );
  }
  const expectedNames = Object.keys(RECEIPT_EVAL_EXPECTED);
  const missingExpected = files.filter((f) => RECEIPT_EVAL_EXPECTED[f] === undefined);
  const missingFile = expectedNames.filter((n) => !files.includes(n));
  if (missingExpected.length > 0 || missingFile.length > 0) {
    throw new EvalSetupError(
      `画像と expected.ts が合いません（正解のない画像 ${missingExpected.length} 件、画像のない正解 ${missingFile.length} 件）`,
    );
  }
  return files.map((name) => {
    const bytes = new Uint8Array(readFileSync(`${IMAGE_DIR}${name}`));
    const mediaType = detectReceiptFormat(bytes);
    const expected = RECEIPT_EVAL_EXPECTED[name];
    if (mediaType === undefined || expected === undefined) {
      throw new EvalSetupError("形式を判定できない画像があります（JPEG・PNG・HEIC・PDF だけ）");
    }
    return { name, bytes, mediaType, expected };
  });
}

/** 接続先。URL とモデルは環境変数、キーは環境変数かキーチェーン。足りなければ `EvalSetupError` */
async function loadEndpoint(): Promise<{ baseUrl: string; model: string; apiKey?: string }> {
  const baseUrl = process.env.TREBUCHET_EVAL_AI_BASE_URL ?? "";
  const model = process.env.TREBUCHET_EVAL_AI_MODEL ?? "";
  if (baseUrl === "" || model === "") {
    throw new EvalSetupError(
      "TREBUCHET_EVAL_AI_BASE_URL と TREBUCHET_EVAL_AI_MODEL を指定してください",
    );
  }
  if (!isAllowedAiBaseUrl(baseUrl)) {
    throw new EvalSetupError("接続先の URL は https:// か localhost の http:// だけです");
  }
  const fromEnv = process.env.TREBUCHET_EVAL_AI_API_KEY;
  const apiKey =
    fromEnv !== undefined && fromEnv !== ""
      ? fromEnv
      : await readApiKey(createKeychainSecretStore());
  return apiKey === undefined ? { baseUrl, model } : { baseUrl, model, apiKey };
}

function report(current: SavedEval, previous: SavedEval | undefined): void {
  const prevField = (field: string) => previous?.fields.find((f) => f.field === field)?.matchRate;
  console.log(
    `証憑の読み取りの評価: ${current.caseCount} 枚（外部の AI。長辺 ${current.maxPx}px、時間切れ ${current.timeoutMs / 1000} 秒）`,
  );
  console.log(
    `  読み取れた（失敗・不正な出力でない）: ${pct(current.succeededRate)}${delta(current.succeededRate, previous?.succeededRate)}`,
  );
  const f = current.failures;
  console.log(
    `  失敗: 時間切れ ${f.AI_TIMEOUT}・AI のエラー ${f.AI_HTTP_ERROR}・不正な出力 ${f.AI_INVALID_OUTPUT}` +
      `・PDF を描けない ${f.RECEIPT_READ_UNSUPPORTED}・変換の失敗 ${f.RECEIPT_CONVERSION_FAILED}`,
  );
  for (const field of RECEIPT_EVAL_FIELDS) {
    const r = current.fields.find((x) => x.field === field);
    if (r === undefined) continue;
    console.log(
      `  ${field}: ${pct(r.matchRate)}（${r.count} 枚）${delta(r.matchRate, prevField(field))}`,
    );
  }
  for (const t of receiptEvalTargets(current)) {
    console.log(`  目標 ${t.field} ${pct(t.target)} 以上: ${t.met ? "達成" : "未達"}`);
  }
  console.log(previous === undefined ? "  前回の結果: なし" : `  前回の結果: ${previous.at}`);
}

try {
  const cases = loadCases();
  const endpoint = await loadEndpoint();
  const reader = createReceiptReader({
    fetch: evalFetch,
    endpoint: async () => endpoint,
  });
  const images = createImageTool({ tmpRoot: TMP_ROOT });
  const context = {
    accounts: counterAccounts(INDIVIDUAL_ACCOUNTS.map((a) => ({ ...a, isActive: true }))).map(
      (a) => ({ code: a.code, name: a.name }),
    ),
    taxCategories: TaxCategoryCode.options,
  };
  const previous = readPrevious<SavedEval>(OUT_DIR);
  console.log(`${cases.length} 枚を外部の AI に送ります（1 枚ずつ。時間がかかります）`);
  const result = await evaluateReceiptReadings(cases, { reader, images, context });
  const saved: SavedEval = {
    at: new Date().toISOString(),
    maxPx: RECEIPT_AI_MAX_PX,
    timeoutMs: RECEIPT_READ_TIMEOUT_MS,
    ...result,
  };
  report(saved, previous);
  console.log(`  保存: ${saveEval(OUT_DIR, saved)}（.tmp/eval-receipts/）`);
} catch (error) {
  // 例外の中身（URL・キーを含みうる）は出さない
  console.error(
    error instanceof EvalSetupError ? error.message : "評価に失敗しました（結果は残しません）",
  );
  process.exitCode = 1;
}
