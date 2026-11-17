/**
 * 見本のバックアップ（`packages/db/test/fixtures/backups/v<版>/`）の要約と照合。`scripts/make-backup-fixture.ts`
 * （作成時の値を expected.json に書く）と `packages/db/test/backup-fixtures.test.ts`（今の版で復元して照合する）が共有する。
 * 要約の形を変えると既存の expected.json と合わなくなるので、項目は足すだけにし、照合は expected にある項目だけで行う。
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AppVersion } from "../../packages/db/src/backup/types.ts";
import type { Database } from "../../packages/db/src/driver.ts";
import { DrizzleLedgerRepository } from "../../packages/db/src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../../packages/db/src/master-repository.ts";
import { openRegistry, openTenant } from "../../packages/db/src/tenant-store.ts";
import { getTrialBalance } from "../../packages/domain/src/usecases/reports.ts";

export const BACKUP_FIXTURES_DIR = fileURLToPath(
  new URL("../../packages/db/test/fixtures/backups/", import.meta.url),
);
export const FIXTURE_BACKUP_FILE = "backup.tbk";
export const FIXTURE_EXPECTED_FILE = "expected.json";

/** 照合しない registry の表（端末に結びつく表。バックアップに含めない）と、マイグレーションの記録 */
const SKIPPED_TABLES = new Set([
  "app_settings",
  "backup_runs",
  "ai_settings",
  "__drizzle_migrations",
]);

export type TrialBalanceExpected = {
  fiscalYear: number;
  rows: {
    accountId: string;
    code: string;
    opening: number;
    debit: number;
    credit: number;
    closing: number;
  }[];
  totals: { debit: number; credit: number; closingDebit: number; closingCredit: number };
};

export type EntityExpected = {
  id: string;
  name: string;
  /** 仕訳の件数（取消・訂正を含む全件） */
  journals: number;
  /** 仕訳と明細の主な列（金額・科目・日付・状態・訂正の元など）の SHA-256。1 件でも変われば違う */
  journalsDigest: string;
  /** 会計期間ごとの残高試算表（期首〜期末。domain の `getTrialBalance`） */
  trialBalances: TrialBalanceExpected[];
  /** 表ごとの行数 */
  rows: Record<string, number>;
};

export type LedgerSummary = {
  registry: { rows: Record<string, number> };
  entities: EntityExpected[];
};

export type FixtureExpected = LedgerSummary & {
  /** 作ったアプリのリリースの版（フォルダ名の v を除いたもの） */
  release: string;
  appVersion: AppVersion;
  createdAt: string;
  /** テスト専用の回復キー（見本のバックアップを開くためだけのもの。実データの鍵ではない） */
  recoveryKey: string;
};

function tableRows(db: Database.Database): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const rows: Record<string, number> = {};
  for (const { name } of tables) {
    if (SKIPPED_TABLES.has(name)) continue;
    const row = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as {
      n: number;
    };
    rows[name] = row.n;
  }
  return rows;
}

function journalsDigest(db: Database.Database): string {
  const hash = createHash("sha256");
  const journals = db
    .prepare(
      "SELECT id, journal_no, date, fiscal_period_id, memo, status, corrects_journal_id FROM journals ORDER BY id",
    )
    .all();
  const lines = db
    .prepare(
      "SELECT id, journal_id, line_no, side, account_id, sub_account_id, amount, tax_category, tax_amount, partner_id, description FROM journal_lines ORDER BY id",
    )
    .all();
  for (const row of journals) hash.update(`j${JSON.stringify(row)}\n`);
  for (const row of lines) hash.update(`l${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function summarizeEntity(id: string, name: string): EntityExpected {
  const db = openTenant(id);
  const masters = new DrizzleMasterRepository(db);
  const deps = { masters, reports: new DrizzleLedgerRepository(db) };
  const trialBalances: TrialBalanceExpected[] = [];
  for (const period of masters.listFiscalPeriods()) {
    const report = getTrialBalance(deps, { from: period.startDate, to: period.endDate });
    if (!report.ok) throw new Error(`試算表を作れない: ${report.error.code}`);
    trialBalances.push({
      fiscalYear: period.fiscalYear,
      rows: report.value.rows.map((r) => ({
        accountId: r.accountId,
        code: r.code,
        opening: r.opening,
        debit: r.debit,
        credit: r.credit,
        closing: r.closing,
      })),
      totals: report.value.totals,
    });
  }
  const client = db.$client;
  const journals = (client.prepare("SELECT count(*) AS n FROM journals").get() as { n: number }).n;
  return {
    id,
    name,
    journals,
    journalsDigest: journalsDigest(client),
    trialBalances,
    rows: tableRows(client),
  };
}

/**
 * 今のデータ場所（`TREBUCHET_DATA_DIR`。DK で解錠済み）の帳簿の要約。registry の表ごとの行数（端末の表を除く）と、
 * 事業体ごとの仕訳・試算表・行数
 */
export function summarizeDataDir(): LedgerSummary {
  const registry = openRegistry().$client;
  const entities = registry.prepare("SELECT id, name FROM entities ORDER BY id").all() as {
    id: string;
    name: string;
  }[];
  return {
    registry: { rows: tableRows(registry) },
    entities: entities.map((e) => summarizeEntity(e.id, e.name)),
  };
}

/** 行数の照合: expected にある表が今もあり、行数が減っていないこと（今の版で増えた表・行は照合しない） */
function compareRows(
  where: string,
  expected: Record<string, number>,
  actual: Record<string, number>,
): string[] {
  const problems: string[] = [];
  for (const [table, count] of Object.entries(expected)) {
    const now = actual[table];
    if (now === undefined) problems.push(`${where}: 表 ${table} がない`);
    else if (now < count) problems.push(`${where}: 表 ${table} の行が ${count} → ${now} に減った`);
  }
  return problems;
}

/** 見本の作成時の値と、今の版で復元した帳簿の要約の違い（空なら一致） */
export function compareSummaries(expected: LedgerSummary, actual: LedgerSummary): string[] {
  const problems = compareRows("registry", expected.registry.rows, actual.registry.rows);
  const byId = new Map(actual.entities.map((e) => [e.id, e]));
  for (const want of expected.entities) {
    const got = byId.get(want.id);
    const where = `事業体 ${want.name}`;
    if (got === undefined) {
      problems.push(`${where}: 復元した帳簿にない`);
      continue;
    }
    if (got.name !== want.name) problems.push(`${where}: 名前が ${got.name} に変わった`);
    if (got.journals !== want.journals) {
      problems.push(`${where}: 仕訳の件数が ${want.journals} → ${got.journals}`);
    }
    if (got.journalsDigest !== want.journalsDigest) {
      problems.push(`${where}: 仕訳・明細の内容が変わった`);
    }
    const tbs = new Map(got.trialBalances.map((t) => [t.fiscalYear, t]));
    for (const tb of want.trialBalances) {
      const now = tbs.get(tb.fiscalYear);
      if (JSON.stringify(now) !== JSON.stringify(tb)) {
        problems.push(
          `${where}: ${tb.fiscalYear} 年度の試算表が違う（作成時 ${JSON.stringify(tb)}、今 ${JSON.stringify(now ?? null)}）`,
        );
      }
    }
    problems.push(...compareRows(where, want.rows, got.rows));
  }
  if (actual.entities.length !== expected.entities.length) {
    problems.push(`事業体の数が ${expected.entities.length} → ${actual.entities.length}`);
  }
  return problems;
}
