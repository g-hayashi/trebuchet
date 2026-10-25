import { randomUUIDv7 } from "node:crypto";
import {
  commitFreeeImport,
  createJournal,
  type FiscalPeriod,
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
  type LineDraft,
  previewFreeeImport,
  type Result,
  voidImportBatch,
  voidJournal,
} from "@trebuchet/domain";
import { balancedLinesArb, dateInPeriodArb, fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FreeeJournalModel,
  type FreeeModel,
  freeeModelArb,
  toFreeeJournalCsv,
} from "../../domain/test/freee-arbitraries.ts";
import { createImportUnitOfWork, DrizzleImportStore } from "../src/import-repository.ts";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, type TenantDb } from "../src/tenant-store.ts";
import { createTestEntity, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// T055: 取込の取消の性質テスト（INV-15 / SC-007）

let tmp: TempDataDir;
let db: TenantDb;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let period: FiscalPeriod;

const ids = { next: () => randomUUIDv7() };
const NOW = "2026-10-19T09:00:00.000Z";
const clock = { now: () => NOW };
const RANGE = { from: "2025-01-01", to: "2025-12-31" };
const SHA = "b".repeat(64);
const REASONS = ["  取り込むファイルを間違えた  ", "やり直す", "期間の指定を誤った\t"];

beforeEach(() => {
  tmp = useTempDataDir("import-void");
  db = openTenant(createTestEntity({ firstFiscalYear: 2025 }).id);
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
  const first = masters.listFiscalPeriods()[0];
  if (first === undefined) throw new Error("会計期間がない");
  period = first;
});
afterEach(() => tmp.cleanup());

type ImportFile = { model: FreeeModel; bytes: Uint8Array };

type Op =
  | { kind: "manual"; date: string; lines: LineDraft[]; voided: boolean }
  | { kind: "import"; file: number }
  | { kind: "void"; nth: number; reason: string };

type Scenario = { files: ImportFile[]; ops: Op[]; target: number; reason: string };

/** ファイルごとに freee の仕訳ID の範囲をずらす（同じファイルの再取込だけが already になる） */
function withIdPrefix(model: FreeeModel, prefix: number): FreeeModel {
  const shift = (j: FreeeJournalModel) => ({ ...j, id: `${prefix}${j.id}` });
  return { ...model, closing: shift(model.closing), journals: model.journals.map(shift) };
}

/** 前年分の決算振替は既定の選択で対象外なので、当年の仕訳を1件以上持つモデルにする */
const modelArb = freeeModelArb({ maxJournals: 5 }).filter((m) => m.journals.length > 0);

function scenarioArb(): fc.Arbitrary<Scenario> {
  const accounts = masters.listAccounts().filter((a) => a.isActive);
  const manualArb = fc.record({
    kind: fc.constant("manual" as const),
    date: dateInPeriodArb(period),
    lines: balancedLinesArb(accounts),
    voided: fc.boolean(),
  });
  return fc
    .array(modelArb, { minLength: 1, maxLength: 3 })
    .map((models) =>
      models.map((model, i) => {
        const shifted = withIdPrefix(model, i + 1);
        return { model: shifted, bytes: toFreeeJournalCsv(shifted) };
      }),
    )
    .chain((files) =>
      fc.record({
        files: fc.constant(files),
        ops: fc.array(
          fc.oneof(
            { weight: 3, arbitrary: manualArb },
            {
              weight: 1,
              arbitrary: fc.record({
                kind: fc.constant("import" as const),
                file: fc.nat(files.length - 1),
              }),
            },
            {
              weight: 1,
              arbitrary: fc.record({
                kind: fc.constant("void" as const),
                nth: fc.nat(),
                reason: fc.constantFrom(...REASONS),
              }),
            },
          ),
          { maxLength: 8 },
        ),
        target: fc.nat(files.length - 1),
        reason: fc.constantFrom(...REASONS),
      }),
    );
}

const uow = () => createImportUnitOfWork(db);
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const inputOf = (file: ImportFile) => ({
  bytes: file.bytes,
  fileName: "journal.csv",
  sha256: SHA,
  options: {},
});

const preview = (file: ImportFile) => unwrap(previewFreeeImport({ uow: uow() }, inputOf(file)));

/** new が1件以上あれば取り込み、取込の回の ID を返す */
function importFile(file: ImportFile): string | undefined {
  const p = preview(file);
  if (p.counts.new === 0) return undefined;
  if (!p.ready) throw new Error(`対応が決まっていない: ${JSON.stringify(p.mappings)}`);
  const committed = commitFreeeImport(
    { uow: uow(), ids, clock },
    { ...inputOf(file), expected: { fileSha256: SHA, countNew: p.counts.new } },
  );
  return unwrap(committed).batch.id;
}

function apply(op: Op, files: ImportFile[], batches: string[]): void {
  switch (op.kind) {
    case "manual": {
      const deps = { ledger, masters, ids, clock };
      const { journal } = unwrap(createJournal(deps, { date: op.date, lines: op.lines }));
      if (op.voided) {
        unwrap(voidJournal(deps, journal.id, { reason: "誤り", version: journal.version }));
      }
      return;
    }
    case "import": {
      const file = files[op.file];
      if (file === undefined) throw new Error(`no file ${op.file}`);
      const batchId = importFile(file);
      if (batchId !== undefined) batches.push(batchId);
      return;
    }
    case "void": {
      const active = new DrizzleImportStore(db)
        .listBatches()
        .filter((b) => b.status === "active" && batches.includes(b.id));
      const batch = active[op.nth % Math.max(active.length, 1)];
      if (batch === undefined) return;
      unwrap(voidImportBatch({ uow: uow(), ids, clock }, { batchId: batch.id, reason: op.reason }));
      return;
    }
  }
}

function reports() {
  const deps = { masters, reports: ledger };
  return {
    trialBalance: unwrap(getTrialBalance(deps, RANGE)),
    profitAndLoss: unwrap(getProfitAndLoss(deps, RANGE)),
    balanceSheet: unwrap(getBalanceSheet(deps, { asOf: RANGE.to })),
  };
}

const decisions = (p: ReturnType<typeof preview>) =>
  Object.fromEntries(p.items.map((i) => [i.freeeJournalId, i.decision]));

type AuditRow = { target_id: string; reason: string | null; occurred_at: string };

function voidAudits(journalIds: string[]): AuditRow[] {
  return db.$client
    .prepare(
      `SELECT target_id, reason, occurred_at FROM audit_log
       WHERE target_type = 'journal' AND action = 'void'
         AND target_id IN (${journalIds.map(() => "?").join(", ")})`,
    )
    .all(...journalIds) as AuditRow[];
}

class Rollback extends Error {}

/** fn を実行し、最後に DB をロールバックする（実行ごとに同じ初期状態から始める） */
function rolledBack(fn: () => void): void {
  db.$client.exec("SAVEPOINT run");
  try {
    fn();
    throw new Rollback();
  } catch (e) {
    db.$client.exec("ROLLBACK TO run");
    db.$client.exec("RELEASE run");
    if (!(e instanceof Rollback)) throw e;
  }
}

describe("取込の取消（T055, INV-15, SC-007）", () => {
  it("任意の手入力・取込・取消の後で、取り込んで取り消すと帳票は取込の前と同じで、同じファイルは再び new になる", () => {
    let checked = 0;
    fc.assert(
      fc.property(scenarioArb(), ({ files, ops, target, reason }) => {
        rolledBack(() => {
          const batches: string[] = [];
          for (const op of ops) apply(op, files, batches);
          const file = files[target];
          if (file === undefined) throw new Error(`no file ${target}`);

          const before = reports();
          const previewBefore = preview(file);
          const batchId = importFile(file);
          // 同じファイルを取り込み済み（取消なし）なら new = 0 で、取り込む仕訳がない
          if (batchId === undefined) {
            expect(previewBefore.counts.new).toBe(0);
            return;
          }
          checked += 1;

          const voided = unwrap(voidImportBatch({ uow: uow(), ids, clock }, { batchId, reason }));
          expect(voided.voidedCount).toBe(previewBefore.counts.new);
          expect(voided.batch).toMatchObject({
            status: "voided",
            voidedAt: NOW,
            voidReason: reason.trim(),
          });

          // INV-15: 帳票の金額は取込の前と同じ
          expect(reports()).toEqual(before);

          // 取り消した仕訳はすべて voided、参照は取消済み、監査ログに理由がある（research R12）
          const journals = new DrizzleImportStore(db).journalsOfBatch(batchId);
          expect(journals).toHaveLength(previewBefore.counts.new);
          for (const { journal, ref } of journals) {
            expect(journal.status).toBe("voided");
            expect(ref.revokedAt).toBe(NOW);
          }
          const journalIds = journals.map((x) => x.journal.id);
          const audits = voidAudits(journalIds);
          expect(audits.map((a) => a.target_id).sort()).toEqual([...journalIds].sort());
          for (const a of audits) {
            expect(a).toMatchObject({ reason: reason.trim(), occurred_at: NOW });
          }

          // 取り消した後は、同じファイルが取込の前と同じ判定（new）に戻る
          const previewAfter = preview(file);
          expect(previewAfter.counts).toEqual(previewBefore.counts);
          expect(decisions(previewAfter)).toEqual(decisions(previewBefore));
          const again = importFile(file);
          expect(again).toBeDefined();
          if (again === undefined) return;
          const reimported = new DrizzleImportStore(db).journalsOfBatch(again);
          expect(reimported).toHaveLength(previewBefore.counts.new);
          expect(
            reimported.every(
              ({ journal, ref }) => journal.status === "active" && ref.revokedAt === null,
            ),
          ).toBe(true);
          expect(reimported.map((x) => x.ref.freeeJournalId).sort()).toEqual(
            journals.map((x) => x.ref.freeeJournalId).sort(),
          );
        });
      }),
      { numRuns: 30 },
    );
    // 取り込む仕訳がない実行ばかりでは性質を確かめていない
    expect(checked).toBeGreaterThan(10);
  });
});
