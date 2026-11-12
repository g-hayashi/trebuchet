/**
 * freee の書き出しファイルの確認（research R3・R18、ローカル専用）。実データは読むだけで、出力もコミットしない。
 *
 * ## 1. ヘッダの確認
 *
 *   pnpm verify:freee --headers-only --journal <仕訳帳.csv> --ledger <総勘定元帳.csv>
 *
 * 判定した文字コード、ヘッダで見つからない列名、メモの列の値に含まれる記号の種類（区切り文字の候補）を出す。
 * 値・金額・取引先は出さない。
 *
 * ## 2. 取込と照合（002/T070）
 *
 *   pnpm verify:freee --journal <仕訳帳.csv> --ledger <総勘定元帳.csv> --year 2025 [--mapping <json>]
 *
 * 使い捨ての事業体（最初の年度 = --year）を `.tmp/verify-freee/` に作り、次を順に行って標準出力に出す。
 *   ヘッダの確認 → 取込（プレビュー → 確定）→ 元帳から期首残高を保存 → 元帳との照合 → PL・BS の科目別の金額
 * 出力は件数、警告のコードと件数（OPENING_DIFFERS_FROM_CARRY_FORWARD = FR-020a を含む）、照合の結果、
 * PL・BS の科目別の金額（0 の科目は省く）。照合が不一致の科目は 科目・期待（freee）・実際（帳簿）・差 を出す。
 * リポジトリの `.tmp/` の外にファイルは書かない。終了コード: 0 = 照合がすべて一致、1 = 未定の対応・不一致・エラー、2 = 使い方の誤り。
 *
 * - 取込の初期案のあとに対応が未定（未定の科目・税区分）が残ると、その一覧を出して終了コード 1 で止まる。
 *   `--mapping` で対応を渡し、もう一度実行する。
 * - `--mapping <json>`: 対応表の JSON（`.tmp/` の下に置く。`.tmp/verify-freee/` の中は実行のたびに消える）。
 *   形は 001・002 の PUT /import-mappings の入力（@trebuchet/schema の ImportMappingsPut）と同じ。
 *   使い捨ての事業体の科目の ID は実行ごとに変わるため、accounts の行は accountId の代わりに
 *   科目名（accountName。初期の勘定科目の名前）でも指定できる。
 *     {
 *       "accounts": [
 *         { "sourceName": "事務用品費", "accountName": "消耗品費" },
 *         { "sourceName": "ＡＢＣカード", "accountName": "未払金", "subAccountName": "ＡＢＣカード" }
 *       ],
 *       "taxes": [{ "sourceName": "課税売上10%", "taxCategory": "<税区分コード>" }]
 *     }
 * - `.tmp/verify-freee/` は終了時に消える（008 以降、一時のデータ場所の DB は実行ごとの乱数の鍵で暗号化し、
 *   鍵を残さないため、前の実行の事業体は使えない。年度ごとに実行し直す）。
 *
 * このファイルは引数の解析と終了コードだけを持つ。取込・期首残高・照合の処理は `lib/freee-import-runner.ts`
 * （`verify-tax-return.ts` と共通。research R12b）。
 */
import { parseArgs } from "node:util";
import {
  finishFreeeImport,
  KINDS,
  resolveMappingPath,
  runFreeeImport,
  StopError,
  verifyHeaders,
} from "./lib/freee-import-runner.ts";

function usage(message: string): never {
  console.error(message);
  console.error("使い方:");
  console.error(
    "  node scripts/verify-freee-import.ts --headers-only [--journal <path>] [--ledger <path>]",
  );
  console.error(
    "  node scripts/verify-freee-import.ts --journal <path> --ledger <path> --year <年度> [--mapping <.tmp/ の下の json>]",
  );
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    "headers-only": { type: "boolean", default: false },
    journal: { type: "string" },
    ledger: { type: "string" },
    year: { type: "string" },
    mapping: { type: "string" },
  },
  strict: true,
});

if (values["headers-only"]) {
  if (values.journal === undefined && values.ledger === undefined) {
    usage("--journal か --ledger のファイルを指定する");
  }
  let ok = true;
  if (values.journal !== undefined) ok = verifyHeaders(values.journal, KINDS.journal) && ok;
  if (values.ledger !== undefined) ok = verifyHeaders(values.ledger, KINDS.ledger) && ok;
  process.exit(ok ? 0 : 1);
}

if (values.journal === undefined || values.ledger === undefined || values.year === undefined) {
  usage("--journal、--ledger、--year を指定する");
}
if (!/^\d{4}$/.test(values.year)) usage("--year は 4 桁の年度");

let mappingFile: string | undefined;
try {
  mappingFile = values.mapping === undefined ? undefined : resolveMappingPath(values.mapping);
} catch (error) {
  if (error instanceof StopError && error.usage) usage(error.message);
  throw error;
}

let exitCode = 1;
try {
  const { matched } = runFreeeImport({
    journal: values.journal,
    ledger: values.ledger,
    year: Number(values.year),
    mapping: mappingFile,
  });
  exitCode = matched ? 0 : 1;
} catch (error) {
  // StopError 以外の例外の中身（実データの値を含みうる）は出さない
  console.error(error instanceof StopError ? error.message : "予期しないエラーで止まりました");
} finally {
  finishFreeeImport();
}
process.exit(exitCode);
