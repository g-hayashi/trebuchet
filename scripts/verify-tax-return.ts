/**
 * 青色申告決算書の実データでの照合（003 の research R15、ローカル専用）。実データは読むだけで、出力もコミットしない。
 *
 *   pnpm verify:tax-return --journal <仕訳帳.csv> --ledger <総勘定元帳.csv> --year 2025 --closing <work/ の JSON>
 *                          [--mapping <json>] [--keep] [--continue]
 *
 * `--journal` `--ledger` `--year` `--mapping` `--keep` `--continue` は `verify-freee-import.ts` と同じ意味で、
 * 取込・期首残高の保存・元帳との照合は `lib/freee-import-runner.ts` が行う（research R12b）。
 * 使い捨ての事業体は `.tmp/verify-freee/` に作る。`--continue` で 2024 年分、2025 年分の順に続けて取り込める。
 * 取込の出力は、止まったとき（未定の対応・不一致・エラー）だけ出す。成功したときは件数だけを出す。
 *
 * ## --closing の JSON（`work/` に置く手書きのファイル。値はリポジトリに書かない）
 *
 *   {
 *     "homeUse": [{ "accountCode": "<科目コード>", "ratio": <事業専用割合。0〜10000 の整数（10000 = 100%）>, "basis": "<根拠のメモ>" }],
 *     "assets": [
 *       {
 *         "name": "<資産の名前>",
 *         "acquiredOn": "<YYYY-MM-DD>",
 *         "cost": <取得価額（円、正の整数）>,
 *         "ratio": <事業専用割合。0〜10000 の整数>,
 *         "linkedJournalNo": <結びつける freee の仕訳番号（省略できる。文字列か数）>
 *       }
 *     ],
 *     "deductionAnswers": { ...控除の回答（T008 のスキーマの形。ここでは形を問わず、オブジェクトであることだけを確かめる） },
 *     "expected": [{ "page": <ページ>, "no": <欄番号（数か文字列）>, "amount": <決算書の金額（円、整数）> }]
 *   }
 *
 * 照合（決算書の各欄と expected の突き合わせ）は T036 で足す。今は JSON の読込と検証、取込、読み込んだ件数の出力まで。
 * 終了コード: 0 = 成功、1 = 取込の停止・JSON の誤り・エラー、2 = 使い方の誤り。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  finishFreeeImport,
  type Log,
  resolveMappingPath,
  runFreeeImport,
  StopError,
} from "./lib/freee-import-runner.ts";

type HomeUse = { accountCode: string; ratio: number; basis: string };
type Asset = {
  name: string;
  acquiredOn: string;
  cost: number;
  ratio: number;
  linkedJournalNo?: string | number;
};
type Expected = { page: number; no: number | string; amount: number };
type ClosingInput = {
  homeUse: HomeUse[];
  assets: Asset[];
  deductionAnswers: Record<string, unknown>;
  expected: Expected[];
};

const RATIO_MAX = 10000;

class ClosingError extends Error {}

function usage(message: string): never {
  console.error(message);
  console.error("使い方:");
  console.error(
    "  node scripts/verify-tax-return.ts --journal <path> --ledger <path> --year <年度> --closing <work/ の json> [--mapping <.tmp/ の下の json>] [--keep] [--continue]",
  );
  process.exit(2);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isRatio = (v: unknown): v is number => isInt(v) && v >= 0 && v <= RATIO_MAX;
const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};

function list(raw: Record<string, unknown>, key: string): unknown[] {
  const value = raw[key];
  if (!Array.isArray(value)) throw new ClosingError(`${key} は配列にする`);
  return value;
}

/** 値は出さない（どの項目が誤りかだけを出す） */
function parseHomeUse(rows: unknown[]): HomeUse[] {
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new ClosingError(`homeUse[${i}] はオブジェクトにする`);
    const { accountCode, ratio, basis } = row;
    if (!isText(accountCode)) throw new ClosingError(`homeUse[${i}].accountCode は空でない文字列`);
    if (!isRatio(ratio)) throw new ClosingError(`homeUse[${i}].ratio は 0〜${RATIO_MAX} の整数`);
    if (!isText(basis)) throw new ClosingError(`homeUse[${i}].basis は空でない文字列`);
    return { accountCode, ratio, basis };
  });
}

function parseAssets(rows: unknown[]): Asset[] {
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new ClosingError(`assets[${i}] はオブジェクトにする`);
    const { name, acquiredOn, cost, ratio, linkedJournalNo } = row;
    if (!isText(name)) throw new ClosingError(`assets[${i}].name は空でない文字列`);
    if (!isDate(acquiredOn)) throw new ClosingError(`assets[${i}].acquiredOn は YYYY-MM-DD`);
    if (!isInt(cost) || cost <= 0) throw new ClosingError(`assets[${i}].cost は正の整数`);
    if (!isRatio(ratio)) throw new ClosingError(`assets[${i}].ratio は 0〜${RATIO_MAX} の整数`);
    if (linkedJournalNo !== undefined && !isText(linkedJournalNo) && !isInt(linkedJournalNo)) {
      throw new ClosingError(`assets[${i}].linkedJournalNo は空でない文字列か整数（省略できる）`);
    }
    const asset: Asset = { name, acquiredOn, cost, ratio };
    if (linkedJournalNo !== undefined) asset.linkedJournalNo = linkedJournalNo;
    return asset;
  });
}

function parseExpected(rows: unknown[]): Expected[] {
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new ClosingError(`expected[${i}] はオブジェクトにする`);
    const { page, no, amount } = row;
    if (!isInt(page) || page < 1) throw new ClosingError(`expected[${i}].page は 1 以上の整数`);
    if (!isText(no) && !isInt(no)) {
      throw new ClosingError(`expected[${i}].no は空でない文字列か整数`);
    }
    if (!isInt(amount)) throw new ClosingError(`expected[${i}].amount は整数`);
    return { page, no, amount };
  });
}

/** --closing の JSON を読んで検証する。誤りは ClosingError（値は出さず、項目の位置だけを伝える） */
function readClosingFile(file: string): ClosingInput {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    // JSON の構文エラーのメッセージには内容の一部が入ることがあるため、種類だけを伝える
    throw new ClosingError(
      error instanceof SyntaxError ? "JSON として読めません" : "ファイルを読めません",
    );
  }
  if (!isRecord(raw)) throw new ClosingError("JSON の最上位はオブジェクトにする");
  const { deductionAnswers } = raw;
  if (!isRecord(deductionAnswers)) throw new ClosingError("deductionAnswers はオブジェクトにする");
  return {
    homeUse: parseHomeUse(list(raw, "homeUse")),
    assets: parseAssets(list(raw, "assets")),
    deductionAnswers,
    expected: parseExpected(list(raw, "expected")),
  };
}

const { values } = parseArgs({
  options: {
    journal: { type: "string" },
    ledger: { type: "string" },
    year: { type: "string" },
    closing: { type: "string" },
    mapping: { type: "string" },
    keep: { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
  },
  strict: true,
});

if (
  values.journal === undefined ||
  values.ledger === undefined ||
  values.year === undefined ||
  values.closing === undefined
) {
  usage("--journal、--ledger、--year、--closing を指定する");
}
if (!/^\d{4}$/.test(values.year)) usage("--year は 4 桁の年度");

let closing: ClosingInput;
try {
  closing = readClosingFile(resolve(values.closing));
} catch (error) {
  if (!(error instanceof ClosingError)) throw error;
  console.error(`--closing の JSON が正しくありません: ${error.message}`);
  process.exit(1);
}

let mappingFile: string | undefined;
try {
  mappingFile = values.mapping === undefined ? undefined : resolveMappingPath(values.mapping);
} catch (error) {
  if (error instanceof StopError && error.usage) usage(error.message);
  throw error;
}

// 取込の出力は止まったときだけ出す（成功したときは件数だけ。金額を画面に残さない）
const buffered: string[] = [];
const log: Log = (message) => {
  buffered.push(message);
};

let exitCode = 1;
try {
  const { matched } = runFreeeImport(
    {
      journal: values.journal,
      ledger: values.ledger,
      year: Number(values.year),
      mapping: mappingFile,
    },
    { keep: values.keep, reuse: values.continue, log },
  );
  if (matched) {
    // T036 で、ここから按分・資産・控除の回答の登録と決算書の各欄の照合を行う
    console.log(`取込: ${values.year} 年度、元帳との照合はすべて一致`);
    console.log(
      `読み込んだ件数: 按分 ${closing.homeUse.length}、資産 ${closing.assets.length}（仕訳に結びつけ ${closing.assets.filter((a) => a.linkedJournalNo !== undefined).length}）、控除の回答の項目 ${Object.keys(closing.deductionAnswers).length}、期待する欄 ${closing.expected.length}`,
    );
    exitCode = 0;
  } else {
    for (const line of buffered) console.log(line);
  }
} catch (error) {
  for (const line of buffered) console.log(line);
  console.error(error instanceof StopError ? error.message : error);
} finally {
  finishFreeeImport(values.keep);
}
process.exit(exitCode);
