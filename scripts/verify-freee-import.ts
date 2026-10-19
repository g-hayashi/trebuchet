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
 * ## 2. 取込と照合（T070）
 *
 *   pnpm verify:freee --journal <仕訳帳.csv> --ledger <総勘定元帳.csv> --year 2025 [--mapping <json>] [--keep] [--continue]
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
 * - `--keep`: 終了後も `.tmp/verify-freee/` を残す（保存した対応表もそのまま残る）。付けなければ終了時に消す（`--continue` の実行も同じ）。
 * - `--continue`: `.tmp/verify-freee/` の事業体を作り直さず使う。別の --year と --journal / --ledger で、
 *   その年度を足す（会計期間がなければ翌年度を作る。前年度を締める必要はない）。
 *   例: 2025 年分を --keep で実行 → 2026 年分を --continue --year 2026 で実行して FR-020a の警告を確かめる。
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む。
 */
import { createHash, randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DrizzleImportUnitOfWork } from "../packages/db/src/import-repository.ts";
import { DrizzleLedgerRepository } from "../packages/db/src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../packages/db/src/master-repository.ts";
import { DrizzleRegistryRepository } from "../packages/db/src/registry-repository.ts";
import { closeAll, openRegistry, openTenant } from "../packages/db/src/tenant-store.ts";
import { TMP_ROOT } from "../packages/db/src/testing.ts";
import { decodeText, parseCsv } from "../packages/domain/src/import/csv.ts";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
  LEDGER_COLUMN_NAMES,
  LEDGER_COLUMNS,
} from "../packages/domain/src/import/freee/columns.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { createEntity } from "../packages/domain/src/usecases/create-entity.ts";
import {
  commitFreeeImport,
  previewFreeeImport,
  proposeFreeeOpening,
  reconcileFreee,
  saveImportMappings,
} from "../packages/domain/src/usecases/import-freee.ts";
import {
  createNextFiscalPeriod,
  replaceOpeningBalances,
} from "../packages/domain/src/usecases/masters.ts";
import { getBalanceSheet, getProfitAndLoss } from "../packages/domain/src/usecases/reports.ts";
import { ImportMappingsPut } from "../packages/schema/src/import.ts";
import type { StatementSection } from "../packages/schema/src/reports.ts";

const HEADER_SEARCH_ROWS = 5;
const MEMO_COLUMNS = [JOURNAL_COLUMNS.debit.memo, JOURNAL_COLUMNS.credit.memo];
// 英数字（全角を含む）・かな・漢字などの文字。これ以外を区切り文字の候補とする
const WORD_CHAR = /[\p{L}\p{N}]/u;

type FileKind = { label: string; columns: readonly string[]; memoColumns: readonly string[] };

const KINDS = {
  journal: { label: "仕訳帳", columns: JOURNAL_COLUMN_NAMES, memoColumns: MEMO_COLUMNS },
  ledger: { label: "総勘定元帳", columns: LEDGER_COLUMN_NAMES, memoColumns: [] },
} satisfies Record<string, FileKind>;

function usage(message: string): never {
  console.error(message);
  console.error("使い方:");
  console.error(
    "  node scripts/verify-freee-import.ts --headers-only [--journal <path>] [--ledger <path>]",
  );
  console.error(
    "  node scripts/verify-freee-import.ts --journal <path> --ledger <path> --year <年度> [--mapping <.tmp/ の下の json>] [--keep] [--continue]",
  );
  process.exit(2);
}

/** 先頭の数行から、列名の一致が最も多い行をヘッダとする */
function findHeader(rows: readonly string[][], columns: readonly string[]) {
  let best: { index: number; header: string[]; hits: number } | undefined;
  for (const [index, row] of rows.slice(0, HEADER_SEARCH_ROWS).entries()) {
    const header = row.map((name) => name.trim());
    const hits = columns.filter((c) => header.includes(c)).length;
    if (hits > 0 && (best === undefined || hits > best.hits)) best = { index, header, hits };
  }
  return best;
}

function describeChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  return /\s/u.test(ch) ? `(空白) ${hex}` : `${JSON.stringify(ch)} ${hex}`;
}

/** 戻り値: 問題がなければ true */
function verifyHeaders(path: string, kind: FileKind): boolean {
  console.log(`## ${kind.label}`);
  const { text, encoding } = decodeText(readFileSync(path));
  console.log(`文字コード: ${encoding}`);

  const rows = parseCsv(text);
  const found = findHeader(rows, kind.columns);
  if (found === undefined) {
    console.log(`ヘッダ: 先頭 ${HEADER_SEARCH_ROWS} 行に既知の列名がない`);
    return false;
  }
  console.log(`ヘッダ: ${found.index + 1} 行目（${found.header.length} 列）`);

  const missing = kind.columns.filter((c) => !found.header.includes(c));
  console.log(
    missing.length === 0
      ? `列名: ${kind.columns.length} 列すべてあり`
      : `見つからない列名（${missing.length} / ${kind.columns.length}）: ${missing.join("、")}`,
  );

  for (const column of kind.memoColumns) {
    const at = found.header.indexOf(column);
    if (at < 0) {
      console.log(`${column}: 列がないため調べない`);
      continue;
    }
    // 記号ごとに、その記号を含む値の数を数える（値そのものは出さない）
    const counts = new Map<string, number>();
    let nonEmpty = 0;
    for (const row of rows.slice(found.index + 1)) {
      const value = row[at] ?? "";
      if (value === "") continue;
      nonEmpty++;
      const symbols = new Set([...value].filter((ch) => !WORD_CHAR.test(ch)));
      for (const ch of symbols) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const kinds = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([ch, n]) => `${describeChar(ch)} ×${n}`);
    console.log(
      `${column}: 値のある行 ${nonEmpty}、記号 ${kinds.length === 0 ? "なし" : kinds.join(", ")}`,
    );
  }
  if (kind === KINDS.ledger) describeOpeningRows(rows.slice(found.index + 1), found.header);
  return missing.length === 0;
}

/** 元帳の開始行（相手勘定科目が前期繰越・開始残高）の形式だけを出す（値・金額は出さない） */
function describeOpeningRows(rows: readonly string[][], header: readonly string[]): void {
  const col = (name: string) => header.indexOf(name);
  const [counter, date, adjusting, debit, credit, journalNo] = [
    col(LEDGER_COLUMNS.counterpart),
    col(LEDGER_COLUMNS.date),
    col(LEDGER_COLUMNS.adjustment),
    col(LEDGER_COLUMNS.debit),
    col(LEDGER_COLUMNS.credit),
    col(LEDGER_COLUMNS.journalNo),
  ];
  const opening = rows.filter((r) => ["前期繰越", "開始残高"].includes(r[counter] ?? ""));
  const kinds = (at: number, f: (v: string) => string) =>
    [...new Set(opening.map((r) => f(r[at] ?? "")))].join(" / ");
  const shape = (v: string) =>
    v === ""
      ? "(空)"
      : /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? "YYYY-MM-DD"
        : /^\d{4}\/\d{2}\/\d{2}$/.test(v)
          ? "YYYY/MM/DD"
          : "(その他)";
  const empty = (v: string) => (v === "" ? "(空)" : "(値あり)");
  const counterKinds = [...new Set(opening.map((r) => r[counter]))].join(" / ");
  const dates = [...new Set(opening.map((r) => r[date] ?? ""))];
  console.log(`開始行: ${opening.length} 行（相手勘定科目: ${counterKinds}）`);
  console.log(`開始行の取引日: 形式 ${kinds(date, shape)}、異なる値の数 ${dates.length}`);
  const allDates = rows
    .map((r) => r[date] ?? "")
    .filter((v) => v !== "")
    .sort();
  console.log(
    `開始行の取引日が全行の最小の取引日と同じ: ${dates.length === 1 && dates[0] === allDates[0]}`,
  );
  console.log(`開始行の決算整理仕訳: ${kinds(adjusting, (v) => (v === "" ? "(空)" : v))}`);
  console.log(
    `開始行の借方金額 ${kinds(debit, empty)}、貸方金額 ${kinds(credit, empty)}、仕訳番号 ${kinds(journalNo, empty)}`,
  );
}

const DATA_DIR = `${TMP_ROOT}verify-freee`;
const AMOUNT = new Intl.NumberFormat("ja-JP");
const yen = (n: number) => AMOUNT.format(n);

class StopError extends Error {}

function unwrap<T>(result: Result<T>, label: string): T {
  if (result.ok) return result.value;
  const { code, message, details } = result.error;
  const extra = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  throw new StopError(`${label}に失敗しました: ${code} ${message}${extra}`);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts.size === 0 ? "なし" : [...counts].map(([k, n]) => `${k} ×${n}`).join(", ");
}

/** 対応表の JSON は `.tmp/` の下（`.tmp/verify-freee/` の外。中は実行のたびに消える）に置く */
function checkMappingPath(path: string): string {
  const file = resolve(path);
  if (!file.startsWith(TMP_ROOT) || file.startsWith(`${DATA_DIR}/`)) {
    usage("--mapping の JSON は .tmp/ の下（.tmp/verify-freee/ の外）に置く");
  }
  return file;
}

/** 対応表の JSON を読む。accounts の行は accountId の代わりに accountName（科目名）でも指定できる */
function readMappingFile(file: string, accounts: readonly { id: string; name: string }[]) {
  const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const rows = (raw as { accounts?: unknown }).accounts;
  const resolved = Array.isArray(rows)
    ? rows.map((row: Record<string, unknown>) => {
        const { accountName, ...rest } = row;
        if (typeof accountName !== "string") return row;
        const found = accounts.filter((a) => a.name === accountName);
        if (found.length !== 1) {
          throw new StopError(`対応表の科目名「${accountName}」が帳簿の科目と1件に決まりません`);
        }
        return { ...rest, accountId: found[0]?.id };
      })
    : rows;
  const parsed = ImportMappingsPut.safeParse({ ...(raw as object), accounts: resolved });
  if (!parsed.success) {
    throw new StopError(`対応表の JSON の形が正しくありません: ${parsed.error.message}`);
  }
  return parsed.data;
}

function printStatement(title: string, sections: readonly StatementSection[]): void {
  console.log(`### ${title}`);
  for (const section of sections) {
    console.log(`${section.section}（合計 ${yen(section.total.amount)}）`);
    for (const row of section.rows.filter((r) => r.amount !== 0)) {
      console.log(`  ${row.code} ${row.name}: ${yen(row.amount)}`);
    }
  }
}

type Args = { journal: string; ledger: string; year: number; mapping?: string | undefined };

/** 戻り値: 照合がすべて一致したら true。未定の対応が残って止まったときは false */
function verifyImport(args: Args, keep: boolean, reuse: boolean): boolean {
  const journalBytes = new Uint8Array(readFileSync(args.journal));
  const ledgerBytes = new Uint8Array(readFileSync(args.ledger));
  const sha256 = createHash("sha256").update(journalBytes).digest("hex");

  console.log("# ヘッダの確認");
  const headersOk =
    verifyHeaders(args.journal, KINDS.journal) && verifyHeaders(args.ledger, KINDS.ledger);
  if (!headersOk) throw new StopError("ヘッダに問題があるため止めました");

  if (!reuse) rmSync(DATA_DIR, { recursive: true, force: true });
  else if (!existsSync(DATA_DIR))
    throw new StopError(`${DATA_DIR} がありません（--keep で実行したあとに --continue を使う）`);
  mkdirSync(DATA_DIR, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = DATA_DIR;

  const ids = { next: () => randomUUIDv7() };
  const clock = { now: () => new Date().toISOString() };
  const registry = new DrizzleRegistryRepository(openRegistry());
  let entityId = registry.listEntities()[0]?.id;
  if (reuse) {
    if (entityId === undefined) throw new StopError("再利用できる事業体がありません");
  } else {
    const created = createEntity(
      {
        registry,
        openTenant: (id) => new DrizzleMasterRepository(openTenant(id)),
        ids,
        clock,
      },
      { name: "freee 照合", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: args.year },
    );
    entityId = unwrap(created, "事業体の作成").id;
  }
  const db = openTenant(entityId);
  const masters = new DrizzleMasterRepository(db);
  const masterDeps = { repo: masters, ids, clock };
  const uow = new DrizzleImportUnitOfWork(db);
  const reports = new DrizzleLedgerRepository(db);

  // 会計期間がなければ翌年度を順に作る（前年度を締める必要はない）
  const firstYear = masters.listFiscalPeriods()[0]?.fiscalYear ?? args.year;
  if (args.year < firstYear) {
    throw new StopError(`${args.year} 年度は最初の会計期間（${firstYear}）より前です`);
  }
  while (masters.getFiscalPeriodByYear(args.year) === undefined) {
    unwrap(createNextFiscalPeriod(masterDeps), "会計期間の作成");
  }
  const period = masters.getFiscalPeriodByYear(args.year);
  if (period === undefined) throw new StopError("会計期間がありません");
  console.log(
    `\n# 事業体 ${entityId}（${DATA_DIR}、${args.year} 年度 ${period.startDate}〜${period.endDate}）`,
  );

  if (args.mapping !== undefined) {
    const mappings = readMappingFile(args.mapping, masters.listAccounts());
    const saved = unwrap(saveImportMappings({ uow, clock }, mappings), "対応表の保存");
    console.log(
      `対応表を保存: 科目 ${mappings.accounts?.length ?? 0} 行、税区分 ${mappings.taxes?.length ?? 0} 行（保存済み合計 科目 ${saved.accounts.length}、税区分 ${saved.taxes.length}）`,
    );
  }

  console.log("\n# 取込（仕訳帳）");
  const input = {
    bytes: journalBytes,
    fileName: "journal.csv",
    sha256,
    options: { fiscalYears: [args.year] },
  };
  const preview = unwrap(previewFreeeImport({ uow }, input), "プレビュー");
  const { counts } = preview;
  console.log(
    `プレビュー: 新規 ${counts.new}、取込済み ${counts.already}、対象外 ${counts.excluded}、不可 ${counts.rejected}、警告 ${counts.warnings}（借方 ${yen(preview.totals.debit)}、貸方 ${yen(preview.totals.credit)}）`,
  );
  const notNew = preview.items.filter((i) => i.decision !== "new" && i.decision !== "already");
  if (notNew.length > 0) {
    console.log(`対象外・取込不可の理由: ${countBy(notNew, (i) => `${i.decision}/${i.reason}`)}`);
  }
  const undecided = [...preview.mappings.accounts, ...preview.mappings.taxes].filter(
    (r) => r.status === "unmapped",
  );
  if (undecided.length > 0) {
    console.log(`\n対応が未定（${undecided.length}）: --mapping で指定してもう一度実行する`);
    for (const r of preview.mappings.accounts.filter((x) => x.status === "unmapped")) {
      console.log(`  科目: ${r.sourceName}`);
    }
    for (const r of preview.mappings.taxes.filter((x) => x.status === "unmapped")) {
      console.log(`  税区分: ${r.sourceName}`);
    }
    return false;
  }
  const warnings = [...preview.warnings];
  if (counts.new > 0) {
    const committed = unwrap(
      commitFreeeImport(
        { uow, ids, clock },
        { ...input, expected: { fileSha256: sha256, countNew: counts.new } },
      ),
      "取込の確定",
    );
    const b = committed.batch;
    console.log(
      `確定: 新規 ${b.countNew}、取込済み ${b.countAlready}、対象外 ${b.countExcluded}、不可 ${b.countRejected}、警告 ${b.countWarnings}`,
    );
  } else {
    console.log("確定: 新規の仕訳がないため取り込まない");
  }
  console.log(`取込の警告: ${countBy(warnings, (w) => w.code)}`);

  console.log("\n# 期首残高（元帳から）");
  const proposal = unwrap(
    proposeFreeeOpening({ uow, reports }, { bytes: ledgerBytes, fiscalYear: args.year }),
    "期首残高の案",
  );
  console.log(
    `案: ${proposal.rows.length} 行、借方 ${yen(proposal.totals.debit)}、貸方 ${yen(proposal.totals.credit)}`,
  );
  console.log(`期首残高の警告: ${countBy(proposal.warnings, (w) => w.code)}`);
  const carry = proposal.comparisons.filter(
    (c) => c.carryForward !== null && c.carryForward !== c.proposed,
  );
  if (carry.length > 0) {
    const names = new Map(masters.listAccounts().map((a) => [a.id, `${a.code} ${a.name}`]));
    console.log("前年度の繰越と違う科目（案 / 繰越）:");
    for (const c of carry) {
      console.log(
        `  ${names.get(c.accountId) ?? c.accountId}: ${yen(c.proposed)} / ${yen(c.carryForward ?? 0)}`,
      );
    }
  }
  if (proposal.unmapped.length > 0) {
    console.log(`期首残高で対応が未定の科目（${proposal.unmapped.length}）: --mapping で指定する`);
    for (const name of proposal.unmapped) console.log(`  科目: ${name}`);
    return false;
  }
  unwrap(
    replaceOpeningBalances(
      masterDeps,
      args.year,
      proposal.rows.map(({ accountId, subAccountId, side, amount }) => ({
        accountId,
        subAccountId,
        side,
        amount,
      })),
    ),
    "期首残高の保存",
  );
  console.log("期首残高を保存した");

  console.log("\n# 元帳との照合");
  const reconciled = unwrap(
    reconcileFreee(
      { uow, reports },
      {
        bytes: ledgerBytes,
        fiscalYear: args.year,
        journal: { bytes: journalBytes, options: input.options },
      },
    ),
    "照合",
  );
  const mismatched = reconciled.rows.filter((r) => !r.matched);
  console.log(
    reconciled.allMatched
      ? `すべて一致（${reconciled.rows.length} 科目）`
      : `不一致 ${mismatched.length} / ${reconciled.rows.length} 科目`,
  );
  if (reconciled.unmapped.length > 0) {
    console.log(`照合で対応が未定の科目: ${reconciled.unmapped.join("、")}`);
  }
  for (const row of mismatched) {
    console.log(`  ${row.accountCode} ${row.accountName}（${row.sourceNames.join("、")}）`);
    for (const key of ["opening", "debit", "credit", "closing"] as const) {
      const diff = row.difference[key];
      if (diff === 0) continue;
      console.log(
        `    ${key}: expected ${yen(row.freee[key])}, actual ${yen(row.book[key])}, diff ${yen(diff)}`,
      );
    }
    for (const c of row.candidates) {
      console.log(
        `    候補: ${c.date} No.${c.freeeJournalNo ?? "-"} 借方 ${yen(c.debit)} 貸方 ${yen(c.credit)} ${c.cause}${c.reason === undefined ? "" : `/${c.reason}`}`,
      );
    }
  }

  console.log("\n# 帳票（research R18。0 の科目は省く）");
  const reportDeps = { masters, reports };
  const pl = unwrap(
    getProfitAndLoss(reportDeps, { from: period.startDate, to: period.endDate }),
    "損益計算書",
  );
  printStatement(`PL ${period.startDate}〜${period.endDate}`, pl.sections);
  console.log(`  差引金額（当期利益）: ${yen(pl.netIncome.amount)}`);
  const bs = unwrap(getBalanceSheet(reportDeps, { asOf: period.endDate }), "貸借対照表");
  printStatement(`BS ${period.endDate}`, bs.sections);
  console.log(`  当期利益（純資産に含む）: ${yen(bs.netIncome.amount)}`);
  console.log(
    `  資産合計 ${yen(bs.totalAssets.amount)}、負債・純資産合計 ${yen(bs.totalLiabilitiesAndEquity.amount)}（${bs.balanced ? "一致" : "不一致"}）`,
  );
  console.log(`帳票の警告: ${countBy([...pl.warnings, ...bs.warnings], (w) => w.code)}`);

  if (keep) console.log(`\n${DATA_DIR} を残した（--continue で別の年度を足せる）`);
  return reconciled.allMatched;
}

const { values } = parseArgs({
  options: {
    "headers-only": { type: "boolean", default: false },
    journal: { type: "string" },
    ledger: { type: "string" },
    year: { type: "string" },
    mapping: { type: "string" },
    keep: { type: "boolean", default: false },
    continue: { type: "boolean", default: false },
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

const mappingFile = values.mapping === undefined ? undefined : checkMappingPath(values.mapping);

let exitCode = 1;
try {
  const matched = verifyImport(
    {
      journal: values.journal,
      ledger: values.ledger,
      year: Number(values.year),
      mapping: mappingFile,
    },
    values.keep,
    values.continue,
  );
  exitCode = matched ? 0 : 1;
} catch (error) {
  console.error(error instanceof StopError ? error.message : error);
} finally {
  closeAll();
  if (!values.keep) rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exit(exitCode);
