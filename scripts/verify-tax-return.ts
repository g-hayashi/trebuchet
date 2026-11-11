/**
 * 青色申告決算書の実データでの照合（003 の research R15、ローカル専用）。実データは読むだけで、出力もコミットしない。
 *
 *   pnpm verify:tax-return --journal <仕訳帳.csv> --ledger <総勘定元帳.csv> --year 2025 --closing <work/ の JSON>
 *                          [--mapping <json>]
 *
 * `--journal` `--ledger` `--year` `--mapping` は `verify-freee-import.ts` と同じ意味で、
 * 取込・期首残高の保存・元帳との照合は `lib/freee-import-runner.ts` が行う（research R12b）。
 * 使い捨ての事業体は `.tmp/verify-freee/` に作り、終了時に消す（1 回の実行で 1 年度だけ取り込む）。
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
 *         "linkedJournalNo": <結びつける freee の仕訳番号（省略できる。文字列か数）>,
 *         "method": "<small_asset_28_2 | straight_line | lump_sum（省略は small_asset_28_2）>",
 *         "inServiceOn": "<事業の用に供した日 YYYY-MM-DD（省略できる）>",
 *         "usefulLifeYears": <耐用年数（正の整数。定額法で必要。省略できる）>,
 *         "priorAccumulated": <前年までの償却累計額（円、0 以上の整数。省略は 0）>,
 *         "priorThroughYear": <累計が何年分までか（4 桁の年。省略できる）>
 *       }
 *     ],
 *     "deferredAssets": [          // 開業費（省略できる。省略は空）
 *       {
 *         "name": "<開業費の名前>", "totalAmount": <総額（円、正の整数）>, "openedOn": "<開業日 YYYY-MM-DD>",
 *         "priorAccumulated": <前年までの償却累計額（省略は 0）>, "priorThroughYear": <累計が何年分までか（省略できる）>,
 *         "accountCode": "<開業費の資産の勘定の科目コード>",
 *         "decisions": [{ "year": <年度（4 桁）>, "amount": <その年度に償却する額（円、0 以上の整数）> }]
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
 * 取込のあと、按分（科目コードで科目を引く）・資産（`linkedJournalNo` があれば取り込んだ freee の仕訳に結びつける。
 * 資産の勘定は一括償却が 1070、ほかは 1060）・開業費と年度ごとの償却額の決定・控除の回答を登録し、`getAdjustmentProposals` の案を登録してから、
 * `getBlueReturn` の各欄を `expected` と照合する。
 * - あわせて警告 `ASSET_REGISTER_MISMATCH`・`DEPRECIATION_MISMATCH`・`DEPRECIATION_PARAMETER_MISSING` の件数と、
 *   欄 18 と 3 ページの必要経費算入額の合計の一致・不一致（`DEPRECIATION_MISMATCH` の有無）を出す
 *   （金額・資産名は出さない）。この 3 つの警告が 1 件でもあれば終了コードは 1
 * - `expected` の page・no は、決算書の CSV の「ページ」「欄番号」と同じ値（1ページは欄の番号、2〜4ページは
 *   `1月`・`内訳1`・`売上先1`・`資産1`・`期首:現金` など）。
 *   同じ欄番号の行が複数ある表（月別の売上、地代家賃の内訳など）は、`name`（CSV の「欄名」）を足して 1 行に特定する。
 *   `name` があれば (page, no, name) で、なければ (page, no) で行を探す。2 行以上に当たるときは「あいまい」として
 *   件数を出し、一致にしない（終了コードは 1）
 * - 出力は欄の識別子と一致・不一致・欄なしの件数だけ。金額・取引先名・按分率は出さない
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
  decideDeferredAmortization,
  saveDeferredAsset,
} from "../packages/domain/src/usecases/deferred-assets.ts";
import {
  finishFreeeImport,
  type ImportContext,
  type Log,
  resolveMappingPath,
  runFreeeImport,
  StopError,
} from "./lib/freee-import-runner.ts";

type HomeUse = { accountCode: string; ratio: number; basis: string };
type AssetMethod = "small_asset_28_2" | "straight_line" | "lump_sum";
type Asset = {
  name: string;
  acquiredOn: string;
  cost: number;
  ratio: number;
  linkedJournalNo?: string | number;
  method: AssetMethod;
  inServiceOn: string | null;
  usefulLifeYears: number | null;
  priorAccumulated: number;
  priorThroughYear: number | null;
};
type DeferredDecision = { year: number; amount: number };
type DeferredAsset = {
  name: string;
  totalAmount: number;
  openedOn: string;
  priorAccumulated: number;
  priorThroughYear: number | null;
  accountCode: string;
  decisions: DeferredDecision[];
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
  deferredAssets: DeferredAsset[];
  deductionAnswers: DeductionAnswers;
  expected: Expected[];
};

const RATIO_MAX = 10000;
const PAGE_MAX = 4;
const NAME_MAX = 500;
const BASIS_MAX = 1000;
/** 少額減価償却資産・定額法の資産の勘定（工具器具備品） */
const ASSET_ACCOUNT_CODE = "1060";
/** 一括償却資産の勘定 */
const LUMP_SUM_ACCOUNT_CODE = "1070";
const ASSET_METHODS: readonly AssetMethod[] = ["small_asset_28_2", "straight_line", "lump_sum"];
/** 償却の警告のうち、1 件でもあれば不一致として終了コード 1 にするもの（009/T024） */
const DEPRECIATION_CODES = [
  "ASSET_REGISTER_MISMATCH",
  "DEPRECIATION_MISMATCH",
  "DEPRECIATION_PARAMETER_MISSING",
] as const;
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
    "  node scripts/verify-tax-return.ts --journal <path> --ledger <path> --year <年度> --closing <work/ の json> [--mapping <.tmp/ の下の json>]",
  );
  process.exit(2);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isRatio = (v: unknown): v is number => isInt(v) && v >= 0 && v <= RATIO_MAX;
const isYear = (v: unknown): v is number => isInt(v) && v >= 1000 && v <= 9999;
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
    const {
      name,
      acquiredOn,
      cost,
      ratio,
      linkedJournalNo,
      method = "small_asset_28_2",
      inServiceOn,
      usefulLifeYears,
      priorAccumulated = 0,
      priorThroughYear,
    } = row;
    if (!isText(name) || name.trim().length > NAME_MAX) {
      throw new ClosingError(`assets[${i}].name は空でない ${NAME_MAX} 文字以下の文字列`);
    }
    if (!isDate(acquiredOn)) throw new ClosingError(`assets[${i}].acquiredOn は YYYY-MM-DD`);
    if (!isInt(cost) || cost <= 0) throw new ClosingError(`assets[${i}].cost は正の整数`);
    if (!isRatio(ratio)) throw new ClosingError(`assets[${i}].ratio は 0〜${RATIO_MAX} の整数`);
    if (linkedJournalNo !== undefined && !isText(linkedJournalNo) && !isInt(linkedJournalNo)) {
      throw new ClosingError(`assets[${i}].linkedJournalNo は空でない文字列か整数（省略できる）`);
    }
    if (!ASSET_METHODS.includes(method as AssetMethod)) {
      throw new ClosingError(`assets[${i}].method は ${ASSET_METHODS.join("・")} のどれか`);
    }
    if (inServiceOn !== undefined && !isDate(inServiceOn)) {
      throw new ClosingError(`assets[${i}].inServiceOn は YYYY-MM-DD（省略できる）`);
    }
    if (usefulLifeYears !== undefined && (!isInt(usefulLifeYears) || usefulLifeYears <= 0)) {
      throw new ClosingError(`assets[${i}].usefulLifeYears は正の整数（省略できる）`);
    }
    if (!isInt(priorAccumulated) || priorAccumulated < 0) {
      throw new ClosingError(`assets[${i}].priorAccumulated は 0 以上の整数（省略できる）`);
    }
    if (priorThroughYear !== undefined && !isYear(priorThroughYear)) {
      throw new ClosingError(`assets[${i}].priorThroughYear は 4 桁の年（省略できる）`);
    }
    const asset: Asset = {
      name: name.trim(),
      acquiredOn,
      cost,
      ratio,
      method: method as AssetMethod,
      inServiceOn: inServiceOn ?? null,
      usefulLifeYears: usefulLifeYears ?? null,
      priorAccumulated,
      priorThroughYear: priorThroughYear ?? null,
    };
    if (linkedJournalNo !== undefined) asset.linkedJournalNo = linkedJournalNo;
    return asset;
  });
}

/** 開業費。省略は空の配列 */
function parseDeferredAssets(rows: unknown): DeferredAsset[] {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new ClosingError("deferredAssets は配列にする");
  return rows.map((row: unknown, i) => {
    if (!isRecord(row)) throw new ClosingError(`deferredAssets[${i}] はオブジェクトにする`);
    const {
      name,
      totalAmount,
      openedOn,
      priorAccumulated = 0,
      priorThroughYear,
      accountCode,
      decisions = [],
    } = row;
    if (!isText(name) || name.trim().length > NAME_MAX) {
      throw new ClosingError(`deferredAssets[${i}].name は空でない ${NAME_MAX} 文字以下の文字列`);
    }
    if (!isInt(totalAmount) || totalAmount <= 0) {
      throw new ClosingError(`deferredAssets[${i}].totalAmount は正の整数`);
    }
    if (!isDate(openedOn)) throw new ClosingError(`deferredAssets[${i}].openedOn は YYYY-MM-DD`);
    if (!isInt(priorAccumulated) || priorAccumulated < 0) {
      throw new ClosingError(`deferredAssets[${i}].priorAccumulated は 0 以上の整数（省略できる）`);
    }
    if (priorThroughYear !== undefined && !isYear(priorThroughYear)) {
      throw new ClosingError(`deferredAssets[${i}].priorThroughYear は 4 桁の年（省略できる）`);
    }
    if (!isText(accountCode)) {
      throw new ClosingError(`deferredAssets[${i}].accountCode は空でない文字列`);
    }
    if (!Array.isArray(decisions)) {
      throw new ClosingError(`deferredAssets[${i}].decisions は配列にする（省略できる）`);
    }
    const parsed = decisions.map((d: unknown, j): DeferredDecision => {
      if (!isRecord(d))
        throw new ClosingError(`deferredAssets[${i}].decisions[${j}] はオブジェクト`);
      if (!isYear(d.year)) {
        throw new ClosingError(`deferredAssets[${i}].decisions[${j}].year は 4 桁の年`);
      }
      if (!isInt(d.amount) || d.amount < 0) {
        throw new ClosingError(`deferredAssets[${i}].decisions[${j}].amount は 0 以上の整数`);
      }
      return { year: d.year, amount: d.amount };
    });
    return {
      name: name.trim(),
      totalAmount,
      openedOn,
      priorAccumulated,
      priorThroughYear: priorThroughYear ?? null,
      accountCode,
      decisions: parsed.sort((a, b) => a.year - b.year),
    };
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
    deferredAssets: parseDeferredAssets(raw.deferredAssets),
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

type Registered = {
  homeUse: number;
  assets: number;
  deferredAssets: number;
  decisions: number;
  linked: number;
  adjustments: number;
};

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
  const needsLumpSum = input.assets.some((a) => a.method === "lump_sum");
  const lumpSumAccount = needsLumpSum
    ? accountByCode(LUMP_SUM_ACCOUNT_CODE, "資産の勘定（一括償却資産）")
    : assetAccount;
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
    must(
      saveFixedAsset(settings, {
        name: asset.name,
        acquiredOn: asset.acquiredOn,
        acquisitionCost: asset.cost,
        method: asset.method,
        usefulLifeYears: asset.usefulLifeYears,
        inServiceOn: asset.inServiceOn,
        priorAccumulated: asset.priorAccumulated,
        priorThroughYear: asset.priorThroughYear,
        businessRatio: asset.ratio,
        assetAccountId: asset.method === "lump_sum" ? lumpSumAccount.id : assetAccount.id,
        linkedJournalId,
      }),
      `assets[${i}] の資産の登録`,
    );
  }

  // 開業費の登録と、年度ごとの償却額の決定（仕訳は案の確定で作る）
  let decisions = 0;
  for (const [i, deferred] of input.deferredAssets.entries()) {
    const account = accountByCode(deferred.accountCode, `deferredAssets[${i}].accountCode`);
    const saved = must(
      saveDeferredAsset(settings, {
        name: deferred.name,
        totalAmount: deferred.totalAmount,
        openedOn: deferred.openedOn,
        priorAccumulated: deferred.priorAccumulated,
        priorThroughYear: deferred.priorThroughYear,
        accountId: account.id,
      }),
      `deferredAssets[${i}] の開業費の登録`,
    );
    for (const [j, decision] of deferred.decisions.entries()) {
      must(
        decideDeferredAmortization(settings, {
          deferredAssetId: saved.id,
          fiscalYear: decision.year,
          amount: decision.amount,
        }),
        `deferredAssets[${i}].decisions[${j}] の償却額の決定`,
      );
      decisions++;
    }
  }

  must(
    saveDeductionAnswers(settings, { fiscalYear: year, answers: input.deductionAnswers }),
    "控除の回答の登録",
  );

  // 案を1件ずつ登録し、そのたびに案を作り直す（登録で他の案の金額が変わっても、金額の不一致にならない）
  const blueDeps = { masters, reports: context.reports, closing };
  let adjustments = 0;
  const limit = input.homeUse.length + input.assets.length + input.deferredAssets.length + 1;
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
    deferredAssets: input.deferredAssets.length,
    decisions,
    linked,
    adjustments,
  };
}

/**
 * 償却まわりの警告の件数と、欄 18 と 3 ページの必要経費算入額の合計の一致（DEPRECIATION_MISMATCH の有無）。
 * 金額・資産名は出さない。3 つの警告がすべて 0 件のときだけ true
 */
function printDepreciationChecks(
  warnings: readonly { code: string }[],
  deferred: { deferredAssets: number; decisions: number },
): boolean {
  const count = (code: string) => warnings.filter((w) => w.code === code).length;
  const counts = DEPRECIATION_CODES.map((code) => `${code} ${count(code)} 件`).join("、");
  console.log(
    `償却の照合: ${counts}（開業費 ${deferred.deferredAssets}、償却額の決定 ${deferred.decisions}）`,
  );
  const line18Matches = count("DEPRECIATION_MISMATCH") === 0;
  console.log(`欄 18 と 3 ページの必要経費算入額の合計: ${line18Matches ? "一致" : "不一致"}`);
  return DEPRECIATION_CODES.every((code) => count(code) === 0);
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
    { log },
  );
  if (matched) {
    importStopped = false;
    console.log(`取込: ${values.year} 年度、元帳との照合はすべて一致`);

    const blueDeps = {
      masters: context.masters,
      reports: context.reports,
      closing: new DrizzleClosingStore(openTenant(context.entityId)),
    };
    const registered = registerClosing(context, closing, year);
    console.log(
      `登録: 按分 ${registered.homeUse}、資産 ${registered.assets}（仕訳に結びつけ ${registered.linked}）、開業費 ${registered.deferredAssets}（償却額の決定 ${registered.decisions}）、控除の回答、決算整理の仕訳 ${registered.adjustments}`,
    );
    const blueReturn = must(getBlueReturn(blueDeps, { fiscalYear: year }), "決算書の作成");
    printWarnings(`${year} 年度`, blueReturn.warnings);
    const depreciationOk = printDepreciationChecks(blueReturn.warnings, registered);
    const same = compareExpected(
      blueReturnToCsv(blueReturn, { blankUnused: false }),
      closing.expected,
    );
    exitCode = same && depreciationOk ? 0 : 1;
  } else {
    for (const line of buffered) console.log(line);
  }
} catch (error) {
  if (importStopped) for (const line of buffered) console.log(line);
  // StopError 以外の例外の中身（実データの値を含みうる）は出さない
  console.error(error instanceof StopError ? error.message : "予期しないエラーで止まりました");
} finally {
  finishFreeeImport();
}
process.exit(exitCode);
