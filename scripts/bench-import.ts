/**
 * SC-002 のベンチマーク: freee の仕訳帳 500 仕訳（複合仕訳を含む）の取込で、プレビューが 5 秒以内、確定が 10 秒以内かを測る。
 * `.tmp/bench-import-<uuid>/` に一時的なテナントを作り、終了時に削除する。
 * 仕訳帳の CSV は freee-arbitraries.ts（T011）の考え方でこのスクリプトの中で生成する（テストのコードには依存しない）。
 * 確定のあとに、同じファイルのプレビューをもう一度測る（全件が「取込済み」。取込の参照を1件ずつ読む処理の確認）。
 *
 *   pnpm bench:import
 *   BENCH_PREVIEW_LIMIT_MS=1000 BENCH_COMMIT_LIMIT_MS=2000 pnpm bench:import   # しきい値の変更
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 */
import { createHash, randomUUIDv7 } from "node:crypto";
import {
  createImportUnitOfWork,
  DrizzleImportStore,
} from "../packages/db/src/import-repository.ts";
import { DrizzleMasterRepository } from "../packages/db/src/master-repository.ts";
import { DrizzleRegistryRepository } from "../packages/db/src/registry-repository.ts";
import { openRegistry, openTenant } from "../packages/db/src/tenant-store.ts";
import { useTempDataDir } from "../packages/db/src/testing.ts";
import {
  JOURNAL_COLUMN_NAMES,
  JOURNAL_COLUMNS,
} from "../packages/domain/src/import/freee/columns.ts";
import { createEntity } from "../packages/domain/src/usecases/create-entity.ts";
import {
  commitFreeeImport,
  previewFreeeImport,
} from "../packages/domain/src/usecases/import-freee.ts";

const JOURNALS = 500;
const FISCAL_YEAR = 2026;
const PREVIEW_LIMIT_MS = positiveNumber("BENCH_PREVIEW_LIMIT_MS", 5_000);
const COMMIT_LIMIT_MS = positiveNumber("BENCH_COMMIT_LIMIT_MS", 10_000);

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} は正の数: ${raw}`);
  return value;
}

type Leg = { account: string; amount: number; partner: string };
type FreeeJournal = { id: string; no: string; date: string; debits: Leg[]; credits: Leg[] };

// 帳簿の初期の科目に同名の科目があるので、対応表の初期案だけで全件が対応する
const PARTNERS = Array.from({ length: 20 }, (_, i) => `取引先${String(i + 1).padStart(2, "0")}`);

/** 2 行と 4 行を交互にして平均 3 行にする。金額は件ごとに変える */
function journalOf(i: number): FreeeJournal {
  const n = 1_000 + ((i * 7_919) % 90_000);
  const partner = PARTNERS[i % PARTNERS.length] ?? "";
  const leg = (account: string, amount: number): Leg => ({ account, amount, partner });
  const yearStart = Date.UTC(FISCAL_YEAR, 0, 1);
  const date = new Date(yearStart + Math.floor((i * 365) / JOURNALS) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const base = { id: String(900_000_000 + i), no: String(i + 1), date };
  switch (i % 4) {
    case 0:
      return { ...base, debits: [leg("売掛金", n * 3)], credits: [leg("売上高", n * 3)] };
    case 1:
      return {
        ...base,
        debits: [leg("普通預金", n * 2), leg("支払手数料", 440)],
        credits: [leg("売掛金", n * 2 + 440 - 300), leg("事業主借", 300)],
      };
    case 2:
      return {
        ...base,
        debits: [leg(i % 8 === 2 ? "消耗品費" : "事業主貸", n)],
        credits: [leg("普通預金", n)],
      };
    default:
      return {
        ...base,
        debits: [leg("地代家賃", 80_000), leg("事業主貸", 20_000 + (i % 100))],
        credits: [leg("普通預金", 60_000), leg("未払金", 40_000 + (i % 100))],
      };
  }
}

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const csvLine = (cells: readonly string[]) => `${cells.map(quote).join(",")}\n`;

/** freee の仕訳帳（取込で使う列だけ、UTF-8、全項目クォート、LF）。1行に借方と貸方の1脚ずつを入れる */
function toFreeeJournalCsv(journals: readonly FreeeJournal[]): Uint8Array {
  const C = JOURNAL_COLUMNS;
  let text = csvLine(JOURNAL_COLUMN_NAMES);
  for (const j of journals) {
    const rowCount = Math.max(j.debits.length, j.credits.length);
    for (let k = 0; k < rowCount; k++) {
      const cells: Record<string, string> = {
        [C.date]: j.date.replaceAll("-", "/"),
        [C.journalId]: j.id,
        [C.journalNo]: j.no,
        [C.lineNo]: String(k + 1),
        [C.lineCount]: String(rowCount),
        [C.adjustment]: "0",
        [C.entryMethod]: "手動",
        [C.description]: `ベンチマーク ${j.no}`,
      };
      for (const [side, leg] of [
        [C.debit, j.debits[k]],
        [C.credit, j.credits[k]],
      ] as const) {
        if (leg === undefined) continue;
        cells[side.account] = leg.account;
        cells[side.amount] = String(leg.amount);
        cells[side.taxCategory] = "対象外";
        cells[side.taxAmount] = "0";
        cells[side.partner] = leg.partner;
      }
      text += csvLine(JOURNAL_COLUMN_NAMES.map((h) => cells[h] ?? ""));
    }
  }
  return new TextEncoder().encode(text);
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const tmp = useTempDataDir("bench-import");
let exitCode = 1;
try {
  const ids = { next: () => randomUUIDv7() };
  const clock = { now: () => new Date().toISOString() };

  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    {
      name: "ベンチマーク",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: FISCAL_YEAR,
    },
  );
  if (!created.ok) throw new Error(`事業体の作成に失敗しました: ${created.error.message}`);
  const db = openTenant(created.value.id);
  new DrizzleMasterRepository(db).replaceTaxSettings([
    {
      id: ids.next(),
      effectiveFrom: `${FISCAL_YEAR}-01-01`,
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  ]);

  const journals = Array.from({ length: JOURNALS }, (_, i) => journalOf(i));
  const rowCount = journals.reduce((n, j) => n + Math.max(j.debits.length, j.credits.length), 0);
  const legCount = journals.reduce((n, j) => n + j.debits.length + j.credits.length, 0);
  const bytes = toFreeeJournalCsv(journals);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(
    `仕訳帳 ${JOURNALS} 仕訳（CSV ${rowCount} 行, 仕訳の行 平均 ${(legCount / JOURNALS).toFixed(1)}, ${bytes.length} バイト）を生成`,
  );

  const uow = createImportUnitOfWork(db);
  const input = { bytes, fileName: "bench-journal.csv", sha256, options: {} };

  const preview = timed(() => previewFreeeImport({ uow }, input));
  if (!preview.value.ok)
    throw new Error(`プレビューに失敗しました: ${preview.value.error.message}`);
  const { counts, ready } = preview.value.value;
  if (!ready || counts.new !== JOURNALS) {
    throw new Error(`プレビューが想定と違います: ready=${ready} counts=${JSON.stringify(counts)}`);
  }

  const commit = timed(() =>
    commitFreeeImport(
      { uow, ids, clock },
      { ...input, expected: { fileSha256: sha256, countNew: JOURNALS } },
    ),
  );
  if (!commit.value.ok) throw new Error(`確定に失敗しました: ${commit.value.error.message}`);
  if (commit.value.value.batch.countNew !== JOURNALS) {
    throw new Error(
      `取り込んだ仕訳が ${JOURNALS} 件ではありません: ${commit.value.value.batch.countNew}`,
    );
  }
  const stored = new DrizzleImportStore(db).listBatches();
  if (stored.length !== 1) throw new Error(`取込の回が 1 件ではありません: ${stored.length}`);

  const again = timed(() => previewFreeeImport({ uow }, input));
  if (!again.value.ok) throw new Error(`再プレビューに失敗しました: ${again.value.error.message}`);
  if (again.value.value.counts.already !== JOURNALS) {
    throw new Error(
      `再プレビューの「取込済み」が ${JOURNALS} 件ではありません: ${JSON.stringify(again.value.value.counts)}`,
    );
  }

  const rows = [
    { step: "preview", "time (ms)": Number(preview.ms.toFixed(1)), limit: PREVIEW_LIMIT_MS },
    { step: "commit", "time (ms)": Number(commit.ms.toFixed(1)), limit: COMMIT_LIMIT_MS },
    {
      step: "preview (after commit, all already)",
      "time (ms)": Number(again.ms.toFixed(1)),
      limit: PREVIEW_LIMIT_MS,
    },
  ].map((r) => ({ ...r, result: r["time (ms)"] <= r.limit ? "OK" : "NG" }));
  console.table(rows);

  const failed = rows.filter((r) => r.result === "NG");
  if (failed.length > 0) {
    console.error(
      `SC-002 を満たしません: ${failed.map((r) => `${r.step}(${r["time (ms)"]} ms > ${r.limit} ms)`).join(", ")}`,
    );
  } else {
    console.log(
      `SC-002 OK: プレビュー ${PREVIEW_LIMIT_MS} ms 以内、確定 ${COMMIT_LIMIT_MS} ms 以内（${JOURNALS} 仕訳）`,
    );
    exitCode = 0;
  }
} catch (error) {
  console.error(error);
} finally {
  tmp.cleanup();
}
process.exitCode = exitCode;
