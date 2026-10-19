import { createHash, randomUUIDv7 } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  commitFreeeImport,
  createEntity,
  getTrialBalance,
  type ImportUnitOfWork,
  previewFreeeImport,
  replaceOpeningBalances,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPECTED_BOOK_ACCOUNTS,
  EXPECTED_JOURNAL,
  EXPECTED_OPENING_PROPOSAL,
  FIXTURE_FILES,
} from "../../domain/test/fixtures/freee/expected.ts";
import { DrizzleImportStore, DrizzleImportUnitOfWork } from "../src/import-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// T024: 取込の確定の統合テスト（テンポラリの SQLite。INV-11、INV-12、SC-005、SC-006）

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;

const ids = { next: () => randomUUIDv7() };
const clock = { now: () => "2026-10-19T09:00:00.000Z" };

const bytes = new Uint8Array(
  readFileSync(
    new URL(`../../domain/test/fixtures/freee/${FIXTURE_FILES.journal}`, import.meta.url),
  ),
);
const sha256 = createHash("sha256").update(bytes).digest("hex");
/** 既定の選択では前年分の決算振替（1件）が対象外になる */
const COUNT_NEW = EXPECTED_JOURNAL.journalCount - EXPECTED_JOURNAL.priorYearClosingIds.length;
const RANGE = { from: "2025-01-01", to: "2025-12-31" };

const input = () => ({
  bytes,
  fileName: FIXTURE_FILES.journal,
  sha256,
  options: {},
  expected: { fileSha256: sha256, countNew: COUNT_NEW },
});

beforeEach(() => {
  tmp = useTempDataDir("import-commit");
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids,
      clock,
    },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2025 },
  );
  if (!created.ok) throw new Error(created.error.message);
  db = openTenant(created.value.id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  masters.replaceTaxSettings([
    {
      id: ids.next(),
      effectiveFrom: "2025-01-01",
      taxpayerStatus: "general",
      accountingMethod: "tax_included",
    },
  ]);
});
afterEach(() => tmp.cleanup());

const COUNTED_TABLES = [
  "journals",
  "journal_lines",
  "journal_line_tags",
  "sub_accounts",
  "partners",
  "tags",
  "import_batches",
  "import_journal_refs",
  "audit_log",
] as const;

function tableCounts(): Record<string, number> {
  return Object.fromEntries(
    COUNTED_TABLES.map((t) => [
      t,
      (db.$client.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );
}

/** 仕訳の登録の failAt 件目で例外を投げる ImportUnitOfWork（同じ接続の1つのトランザクション） */
function failingUow(failAt: number): ImportUnitOfWork {
  return {
    transaction: (fn) =>
      db.transaction((tx) => {
        const txLedger = new DrizzleLedgerRepository(tx);
        const insert = txLedger.insertJournal.bind(txLedger);
        let calls = 0;
        txLedger.insertJournal = (journal) => {
          calls += 1;
          if (calls === failAt) throw new Error(`injected failure at journal ${failAt}`);
          return insert(journal);
        };
        return fn({
          ledger: txLedger,
          masters: new DrizzleMasterRepository(tx),
          imports: new DrizzleImportStore(tx),
        });
      }),
  };
}

const commitDeps = (uow: ImportUnitOfWork = new DrizzleImportUnitOfWork(db)) => ({
  uow,
  ids,
  clock,
});

function trialBalance() {
  const result = getTrialBalance({ masters, reports: ledger }, RANGE);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("commitFreeeImport（DrizzleImportUnitOfWork）", () => {
  it.each([1, Math.ceil(COUNT_NEW / 2), COUNT_NEW])(
    "INV-11 / SC-006: 仕訳の登録の %i 件目で例外が起きると、何も残らない",
    (failAt) => {
      const before = tableCounts();
      expect(() => commitFreeeImport(commitDeps(failingUow(failAt)), input())).toThrow(
        "injected failure",
      );
      expect(tableCounts()).toEqual(before);
      expect(new DrizzleImportStore(db).listBatches()).toEqual([]);
    },
  );

  it("例外を注入しなければ、同じ準備で取り込める（上のテストの前提の確認）", () => {
    const before = tableCounts();
    const result = commitFreeeImport(commitDeps(failingUow(0)), input());
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const after = tableCounts();
    expect(after.journals).toBe((before.journals ?? 0) + COUNT_NEW);
    expect(after.import_journal_refs).toBe(COUNT_NEW);
    expect(after.import_batches).toBe(1);
    expect(after.sub_accounts).toBeGreaterThan(before.sub_accounts ?? 0);
    expect(after.partners).toBeGreaterThan(before.partners ?? 0);
    expect(after.tags).toBeGreaterThan(before.tags ?? 0);
  });

  it("INV-12 / SC-005: 同じファイルの2回目は new = 0 で、仕訳の件数と試算表が1回目と同じ", () => {
    const first = commitFreeeImport(commitDeps(), input());
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    expect(first.value.batch.countNew).toBe(COUNT_NEW);
    const counts = tableCounts();
    const balance = trialBalance();

    const preview = previewFreeeImport({ uow: new DrizzleImportUnitOfWork(db) }, input());
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    expect(preview.value.counts).toMatchObject({ new: 0, already: COUNT_NEW });
    expect(preview.value.ready).toBe(false);

    const second = commitFreeeImport(commitDeps(), input());
    expect(second.ok ? undefined : second.error.code).toBe("IMPORT_NOT_READY");
    expect(tableCounts()).toEqual(counts);
    expect(trialBalance()).toEqual(balance);
  });

  it("フィクスチャの取込後の試算表が expected.ts と一致する", () => {
    const result = commitFreeeImport(commitDeps(), input());
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    // 期首残高は元帳からの案（expected.ts）を登録する。補助科目「ABCカード」は取込で作られる
    const accounts = masters.listAccounts();
    const subAccounts = masters.listSubAccounts();
    const idOf = (code: string) => {
      const found = accounts.find((a) => a.code === code);
      if (found === undefined) throw new Error(`科目がない: ${code}`);
      return found.id;
    };
    const opening = replaceOpeningBalances(
      { repo: masters, ids, clock },
      2025,
      EXPECTED_OPENING_PROPOSAL.map((row) => {
        const accountId = idOf(row.code);
        const sub = subAccounts.find(
          (s) => s.accountId === accountId && s.name === row.subAccountName,
        );
        if (row.subAccountName !== undefined && sub === undefined) {
          throw new Error(`補助科目がない: ${row.subAccountName}`);
        }
        return { accountId, subAccountId: sub?.id ?? null, side: row.side, amount: row.amount };
      }),
    );
    if (!opening.ok) throw new Error(JSON.stringify(opening.error));

    const report = trialBalance();
    expect(report.balanced).toBe(true);
    for (const row of report.rows) {
      const expected = EXPECTED_BOOK_ACCOUNTS[row.code] ?? {
        opening: 0,
        debit: 0,
        credit: 0,
        closing: 0,
      };
      expect(
        { opening: row.opening, debit: row.debit, credit: row.credit, closing: row.closing },
        `${row.code} ${row.name}`,
      ).toEqual(expected);
    }
    const codes = new Set(report.rows.map((r) => r.code));
    for (const code of Object.keys(EXPECTED_BOOK_ACCOUNTS)) expect(codes).toContain(code);
  });
});
