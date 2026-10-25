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
 *     "deductionAnswers": {
 *       "doubleEntry": <true | false>, "statementsAttached": <true | false>, "filedOnTime": <true | false>,
 *       "eTax": <true | false>, "electronicBooks": <true | false>
 *     },
 *     "expected": [{
 *       "page": <ページ。1〜4>, "no": <欄番号（数か文字列）>,
 *       "name": "<CSV の「欄名」と同じ値（省略できる）>", "amount": <決算書の金額（円、整数）>
 *     }]
 *   }
 *
 * ## 照合
 *
 * 取込のあと、按分（科目コードで科目を引く）・資産（`linkedJournalNo` があれば取り込んだ freee の仕訳に結びつけ、
 * 同じ名前・取得日・取得価額の資産があれば更新）・控除の回答を登録し、`getAdjustmentProposals` の案を登録してから、
 * `getBlueReturn` の各欄を `expected` と照合する。
 * - `expected` の page・no は、決算書の CSV の「ページ」「欄番号」と同じ値（1ページは欄の番号、2〜4ページは
 *   `1月`・`内訳1`・`売上先1`・`資産1`・`期首:現金` など）。
 *   同じ欄番号の行が複数ある表（月別の売上、地代家賃の内訳など）は、`name`（CSV の「欄名」）を足して 1 行に特定する。
 *   `name` があれば (page, no, name) で、なければ (page, no) で行を探す。2 行以上に当たるときは「あいまい」として
 *   件数を出し、一致にしない（終了コードは 1）
 * - 出力は欄の識別子と一致・不一致・欄なしの件数だけ。金額・取引先名・按分率は出さない
 * - `--continue` で複数年度を取り込んだときは、前の年度の決算書も作り、各年度の警告のコード
 *   （NEGATIVE_BALANCE、OPENING_MISMATCH）と科目名だけを出す
 * 終了コード: 0 = 成功（すべて一致）、1 = 不一致・取込の停止・JSON の誤り・エラー、2 = 使い方の誤り。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createClosingUnitOfWork,
  DrizzleClosingStore,
} from "../packages/db/src/closing-repository.ts";
import { DrizzleImportStore } from "../packages/db/src/import-repository.ts";
import { openTenant } from "../packages/db/src/tenant-store.ts";
import { blueReturnToCsv } from "../packages/domain/src/blue-return/csv.ts";
import { parseCsv } from "../packages/domain/src/import/csv.ts";
import type { Result } from "../packages/domain/src/types.ts";
import {
  commitAdjustment,
  getAdjustmentProposals,
  getBlueReturn,
  saveDeductionAnswers,
  saveFixedAsset,
  saveHomeUseAllocation,
} from "../packages/domain/src/usecases/blue-return.ts";
import {
  finishFreeeImport,
  type ImportContext,
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
type Expected = { page: number; no: number | string; name?: string; amount: number };
type DeductionAnswers = {
  doubleEntry: boolean;
  statementsAttached: boolean;
  filedOnTime: boolean;
  eTax: boolean;
  electronicBooks: boolean;
};
type ClosingInput = {
  homeUse: HomeUse[];
  assets: Asset[];
  deductionAnswers: DeductionAnswers;
  expected: Expected[];
};

const RATIO_MAX = 10000;
const PAGE_MAX = 4;
const NAME_MAX = 500;
const BASIS_MAX = 1000;
/** 少額減価償却資産の既定の資産の勘定（工具器具備品） */
const ASSET_ACCOUNT_CODE = "1060";
const DEDUCTION_KEYS = [
  "doubleEntry",
  "statementsAttached",
  "filedOnTime",
  "eTax",
  "electronicBooks",
] as const;

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
    if (!isText(basis) || basis.length > BASIS_MAX) {
      throw new ClosingError(`homeUse[${i}].basis は空でない ${BASIS_MAX} 文字以下の文字列`);
    }
    if (!isRatio(ratio)) throw new ClosingError(`homeUse[${i}].ratio は 0〜${RATIO_MAX} の整数`);
    return { accountCode, ratio, basis };
  });
}

function parseAssets(rows: unknown[]): Asset[] {
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new ClosingError(`assets[${i}] はオブジェクトにする`);
    const { name, acquiredOn, cost, ratio, linkedJournalNo } = row;
    if (!isText(name) || name.trim().length > NAME_MAX) {
      throw new ClosingError(`assets[${i}].name は空でない ${NAME_MAX} 文字以下の文字列`);
    }
    if (!isDate(acquiredOn)) throw new ClosingError(`assets[${i}].acquiredOn は YYYY-MM-DD`);
    if (!isInt(cost) || cost <= 0) throw new ClosingError(`assets[${i}].cost は正の整数`);
    if (!isRatio(ratio)) throw new ClosingError(`assets[${i}].ratio は 0〜${RATIO_MAX} の整数`);
    if (linkedJournalNo !== undefined && !isText(linkedJournalNo) && !isInt(linkedJournalNo)) {
      throw new ClosingError(`assets[${i}].linkedJournalNo は空でない文字列か整数（省略できる）`);
    }
    const asset: Asset = { name: name.trim(), acquiredOn, cost, ratio };
    if (linkedJournalNo !== undefined) asset.linkedJournalNo = linkedJournalNo;
    return asset;
  });
}

function parseExpected(rows: unknown[]): Expected[] {
  return rows.map((row, i) => {
    if (!isRecord(row)) throw new ClosingError(`expected[${i}] はオブジェクトにする`);
    const { page, no, name, amount } = row;
    if (!isInt(page) || page < 1 || page > PAGE_MAX) {
      throw new ClosingError(`expected[${i}].page は 1〜${PAGE_MAX} の整数`);
    }
    if (!isText(no) && !isInt(no)) {
      throw new ClosingError(`expected[${i}].no は空でない文字列か整数`);
    }
    if (name !== undefined && !isText(name)) {
      throw new ClosingError(`expected[${i}].name は空でない文字列（省略できる）`);
    }
    if (!isInt(amount)) throw new ClosingError(`expected[${i}].amount は整数`);
    return name === undefined ? { page, no, amount } : { page, no, name, amount };
  });
}

/** 控除の回答は、5 つの項目がすべて真偽値で、ほかの項目がないこと（schema の DeductionAnswersInput と同じ） */
function parseDeductionAnswers(value: unknown): DeductionAnswers {
  if (!isRecord(value)) throw new ClosingError("deductionAnswers はオブジェクトにする");
  for (const key of Object.keys(value)) {
    if (!(DEDUCTION_KEYS as readonly string[]).includes(key)) {
      throw new ClosingError("deductionAnswers に余分な項目がある");
    }
  }
  const { doubleEntry, statementsAttached, filedOnTime, eTax, electronicBooks } = value;
  for (const key of DEDUCTION_KEYS) {
    if (typeof value[key] !== "boolean") {
      throw new ClosingError(`deductionAnswers.${key} は true か false`);
    }
  }
  return {
    doubleEntry: doubleEntry === true,
    statementsAttached: statementsAttached === true,
    filedOnTime: filedOnTime === true,
    eTax: eTax === true,
    electronicBooks: electronicBooks === true,
  };
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
  return {
    homeUse: parseHomeUse(list(raw, "homeUse")),
    assets: parseAssets(list(raw, "assets")),
    deductionAnswers: parseDeductionAnswers(raw.deductionAnswers),
    expected: parseExpected(list(raw, "expected")),
  };
}

/** 失敗はエラーコードだけを伝える（details に金額が入ることがあるため、message と details は出さない） */
function must<T>(result: Result<T>, label: string): T {
  if (result.ok) return result.value;
  throw new StopError(`${label}に失敗しました: ${result.error.code}`);
}

/** 取り込んだ freee の仕訳番号から、帳簿の仕訳の ID を1件に決める */
function findImportedJournalId(imports: DrizzleImportStore, no: string | number): string | null {
  const found: string[] = [];
  for (const batch of imports.listBatches()) {
    for (const { ref } of imports.journalsOfBatch(batch.id)) {
      if (ref.revokedAt === null && ref.freeeJournalNo === String(no)) found.push(ref.journalId);
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

type Registered = { homeUse: number; assets: number; linked: number; adjustments: number };

/** 按分・資産・控除の回答を登録し、決算整理の仕訳の案をすべて登録する */
function registerClosing(context: ImportContext, input: ClosingInput, year: number): Registered {
  const db = openTenant(context.entityId);
  const closing = new DrizzleClosingStore(db);
  const imports = new DrizzleImportStore(db);
  const { masters, ids, clock } = context;
  const uow = createClosingUnitOfWork(db);
  const settings = { uow, ids, clock };
  const accounts = masters.listAccounts();
  const accountByCode = (code: string, where: string) => {
    const found = accounts.filter((a) => a.code === code);
    if (found.length !== 1 || found[0] === undefined) {
      throw new StopError(`${where} に対応する科目が1件に決まりません`);
    }
    return found[0];
  };

  for (const [i, row] of input.homeUse.entries()) {
    const account = accountByCode(row.accountCode, `homeUse[${i}].accountCode`);
    must(
      saveHomeUseAllocation(settings, {
        fiscalYear: year,
        accountId: account.id,
        subAccountId: null,
        businessRatio: row.ratio,
        basis: row.basis,
        changeReason: "実データの照合（verify:tax-return）",
      }),
      `homeUse[${i}] の按分の登録`,
    );
  }

  const assetAccount = accountByCode(ASSET_ACCOUNT_CODE, "資産の勘定（工具器具備品）");
  let linked = 0;
  for (const [i, asset] of input.assets.entries()) {
    let linkedJournalId: string | null = null;
    if (asset.linkedJournalNo !== undefined) {
      linkedJournalId = findImportedJournalId(imports, asset.linkedJournalNo);
      if (linkedJournalId === null) {
        throw new StopError(
          `assets[${i}].linkedJournalNo に対応する取込済みの仕訳が1件に決まりません`,
        );
      }
      linked++;
    }
    // 同じ名前・取得日・取得価額の資産があれば更新（--continue での再実行で重複させない）
    const existing = closing
      .listFixedAssets()
      .find(
        (a) =>
          a.name === asset.name &&
          a.acquiredOn === asset.acquiredOn &&
          a.acquisitionCost === asset.cost,
      );
    must(
      saveFixedAsset(settings, {
        ...(existing === undefined ? {} : { id: existing.id }),
        name: asset.name,
        acquiredOn: asset.acquiredOn,
        acquisitionCost: asset.cost,
        method: "small_asset_28_2",
        businessRatio: asset.ratio,
        assetAccountId: assetAccount.id,
        linkedJournalId,
      }),
      `assets[${i}] の資産の登録`,
    );
  }

  must(
    saveDeductionAnswers(settings, { fiscalYear: year, answers: input.deductionAnswers }),
    "控除の回答の登録",
  );

  // 案を1件ずつ登録し、そのたびに案を作り直す（登録で他の案の金額が変わっても、金額の不一致にならない）
  const blueDeps = { masters, reports: context.reports, closing };
  let adjustments = 0;
  const limit = input.homeUse.length + input.assets.length + 1;
  for (;;) {
    const proposal = must(getAdjustmentProposals(blueDeps, { fiscalYear: year }), "案の作成")[0];
    if (proposal === undefined) break;
    if (adjustments >= limit) throw new StopError("決算整理の仕訳の案が登録しても減りません");
    const amount = proposal.journal.lines
      .filter((l) => l.side === "debit")
      .reduce((sum, l) => sum + l.amount, 0);
    must(
      commitAdjustment(
        { uow, reports: context.reports, ids, clock },
        {
          fiscalYear: year,
          kind: proposal.kind,
          sourceId: proposal.sourceId,
          expected: { amount },
        },
      ),
      "決算整理の仕訳の登録",
    );
    adjustments++;
  }
  return {
    homeUse: input.homeUse.length,
    assets: input.assets.length,
    linked,
    adjustments,
  };
}

const WATCHED_CODES = ["NEGATIVE_BALANCE", "OPENING_MISMATCH"] as const;

/** 警告のコードごとの件数と、NEGATIVE_BALANCE・OPENING_MISMATCH の科目名（金額は出さない） */
function printWarnings(
  label: string,
  warnings: readonly { code: string; details?: Record<string, unknown> | undefined }[],
): void {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
  const summary = [...counts].map(([code, n]) => `${code} ×${n}`).join(", ");
  console.log(`${label}の警告: ${summary === "" ? "なし" : summary}`);
  for (const code of WATCHED_CODES) {
    const names = warnings
      .filter((w) => w.code === code)
      .map((w) => w.details?.accountName)
      .filter((name): name is string => typeof name === "string");
    if (names.length > 0) console.log(`  ${code}: ${[...new Set(names)].join("、")}`);
  }
}

type CsvRow = { page: string; no: string; name: string; amount: string };

/** 決算書の CSV の行（ページ、欄番号、欄名、金額）。金額が空の欄は "" */
function csvRows(csvText: string): CsvRow[] {
  const bomless = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;
  return parseCsv(bomless)
    .slice(1)
    .map(([page, no, name, amount]) => ({
      page: page ?? "",
      no: no ?? "",
      name: name ?? "",
      amount: amount ?? "",
    }));
}

/**
 * 決算書の各欄と expected を突き合わせる。name があれば (page, no, name)、なければ (page, no) で
 * 1 行に特定する。2 行以上に当たるときは「あいまい」（一致にしない）。
 * 出力は欄の識別子（ページと欄番号）と件数だけ（欄名・金額は出さない）。すべて一致のときだけ true
 */
function compareExpected(csvText: string, expected: readonly Expected[]): boolean {
  const rows = csvRows(csvText);
  let same = 0;
  let different = 0;
  let missing = 0;
  let ambiguous = 0;
  for (const e of expected) {
    const hits = rows.filter(
      (r) =>
        r.page === String(e.page) &&
        r.no === String(e.no) &&
        (e.name === undefined || r.name === e.name),
    );
    const id = `${e.page}ページ 欄 ${e.no}${e.name === undefined ? "" : "（欄名あり）"}`;
    const hit = hits[0];
    if (hit === undefined) {
      missing++;
      console.log(`  欄なし: ${id}`);
    } else if (hits.length > 1) {
      ambiguous++;
      console.log(`  あいまい: ${id}（${hits.length} 行。expected に name を足す）`);
    } else if (hit.amount === String(e.amount)) {
      same++;
      console.log(`  一致: ${id}`);
    } else {
      different++;
      console.log(`  不一致: ${id}`);
    }
  }
  console.log(
    `欄の照合: 一致 ${same}、不一致 ${different}、欄なし ${missing}、あいまい ${ambiguous}（期待する欄 ${expected.length}）`,
  );
  return different === 0 && missing === 0 && ambiguous === 0;
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

const year = Number(values.year);
let exitCode = 1;
// 取込の出力（金額を含む）は、取込が止まったときだけ出す。取込の後の失敗では出さない
let importStopped = true;
try {
  const { matched, context } = runFreeeImport(
    { journal: values.journal, ledger: values.ledger, year, mapping: mappingFile },
    { keep: values.keep, reuse: values.continue, log },
  );
  if (matched) {
    importStopped = false;
    console.log(`取込: ${values.year} 年度、元帳との照合はすべて一致`);

    // 前の年度（--continue で取り込んだもの）の決算書。警告のコードと科目名だけを出す
    const blueDeps = {
      masters: context.masters,
      reports: context.reports,
      closing: new DrizzleClosingStore(openTenant(context.entityId)),
    };
    const earlier = context.masters
      .listFiscalPeriods()
      .map((p) => p.fiscalYear)
      .filter((y) => y < year)
      .sort((a, b) => a - b);
    for (const y of earlier) {
      const prior = must(getBlueReturn(blueDeps, { fiscalYear: y }), `${y} 年度の決算書`);
      printWarnings(`${y} 年度`, prior.warnings);
    }

    const registered = registerClosing(context, closing, year);
    console.log(
      `登録: 按分 ${registered.homeUse}、資産 ${registered.assets}（仕訳に結びつけ ${registered.linked}）、控除の回答、決算整理の仕訳 ${registered.adjustments}`,
    );
    const blueReturn = must(getBlueReturn(blueDeps, { fiscalYear: year }), "決算書の作成");
    printWarnings(`${year} 年度`, blueReturn.warnings);
    const same = compareExpected(
      blueReturnToCsv(blueReturn, { blankUnused: false }),
      closing.expected,
    );
    exitCode = same ? 0 : 1;
  } else {
    for (const line of buffered) console.log(line);
  }
} catch (error) {
  if (importStopped) for (const line of buffered) console.log(line);
  console.error(error instanceof StopError ? error.message : error);
} finally {
  finishFreeeImport(values.keep);
}
process.exit(exitCode);
