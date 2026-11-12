import { randomUUIDv7 } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type EntityKind,
  type FiscalPeriod,
  type Journal,
  type LineDraft,
  type NewJournal,
  type OpeningBalance,
  validateJournal,
} from "@trebuchet/domain";
import {
  balancedLinesArb,
  balancedOpeningArb,
  dateInPeriodArb,
  fc,
} from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant, tenantFile } from "../src/tenant-store.ts";
import { createTestEntity, type TempDataDir, testClock, useTempDataDir } from "../src/testing.ts";

type Tenant = {
  entityId: string;
  masters: DrizzleMasterRepository;
  ledger: DrizzleLedgerRepository;
  period: FiscalPeriod;
};

type Draft = { date: string; lines: LineDraft[]; voided: boolean };
type TenantData = { drafts: Draft[]; opening: OpeningBalance[] };
type Saved = { journals: Journal[]; opening: OpeningBalance[] };

let tmp: TempDataDir;
let a: Tenant;
let b: Tenant;

const clock = testClock();

function setupTenant(name: string, kind: EntityKind): Tenant {
  const entity = createTestEntity({ name, kind });
  const db = openTenant(entity.id);
  const masters = new DrizzleMasterRepository(db);
  const period = masters.listFiscalPeriods()[0];
  if (period === undefined) throw new Error("会計期間がない");
  return { entityId: entity.id, masters, ledger: new DrizzleLedgerRepository(db), period };
}

beforeEach(() => {
  tmp = useTempDataDir("isolation");
  a = setupTenant("個人事業", "individual");
  b = setupTenant("法人", "corporation");
});
afterEach(() => tmp.cleanup());

const activeAccounts = (t: Tenant) => t.masters.listAccounts().filter((x) => x.isActive);

function tenantDataArb(t: Tenant): fc.Arbitrary<TenantData> {
  const accounts = activeAccounts(t);
  return fc.record({
    drafts: fc.array(
      fc.record({
        date: dateInPeriodArb(t.period),
        lines: balancedLinesArb(accounts),
        voided: fc.boolean(),
      }),
      { maxLength: 15 },
    ),
    opening: balancedOpeningArb(accounts).map((rows) =>
      rows.map((r) => ({
        ...r,
        id: randomUUIDv7(),
        fiscalPeriodId: t.period.id,
        subAccountId: null,
      })),
    ),
  });
}

class Rollback extends Error {}

/** 仕訳を登録して fn を実行し、最後にロールバックする。期首残高は実行ごとに置き換える */
function withSeeds(
  t: Tenant,
  data: TenantData,
  fn: (tx: DrizzleLedgerRepository, saved: Saved) => void,
) {
  const m = t.masters;
  const ctx = {
    accounts: m.listAccounts(),
    subAccounts: m.listSubAccounts(),
    partners: m.listPartners(),
    tags: m.listTags(),
    periods: m.listFiscalPeriods(),
    taxSettings: m.listTaxSettings(),
    taxRates: m.listTaxRates(),
  };
  m.replaceOpeningBalances(t.period.id, data.opening);
  try {
    t.ledger.transaction((tx) => {
      if (!(tx instanceof DrizzleLedgerRepository)) throw new Error("想定外のリポジトリ");
      const journals = data.drafts.map(({ voided, ...draft }) => {
        const valid = validateJournal(draft, ctx);
        if (!valid.ok) throw new Error(JSON.stringify(valid.error));
        const journal: NewJournal = {
          ...valid.value,
          id: randomUUIDv7(),
          journalNo: tx.nextJournalNo(),
          createdAt: clock.now(),
          lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
        };
        const saved = tx.insertJournal(journal);
        return voided ? tx.voidJournal(saved.id, saved.version, clock.now()) : saved;
      });
      fn(tx, { journals, opening: data.opening });
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** テナントの読み取りの結果が、そのテナントで登録したものと一致する（他方の ID を含まない） */
function expectOnlyOwn(t: Tenant, tx: DrizzleLedgerRepository, own: Saved, other: Saved) {
  const ownAccountIds = new Set(t.masters.listAccounts().map((x) => x.id));
  const otherJournalIds = new Set(other.journals.map((j) => j.id));
  const otherLineIds = new Set(other.journals.flatMap((j) => j.lines.map((l) => l.id)));
  const otherOpeningIds = new Set(other.opening.map((o) => o.id));

  const found = tx.findJournals({ includeVoided: true, limit: 200 }).items;
  expect(sorted(found.map((j) => j.id))).toEqual(sorted(own.journals.map((j) => j.id)));
  expect(found.some((j) => otherJournalIds.has(j.id))).toBe(false);
  expect(found.flatMap((j) => j.lines).some((l) => otherLineIds.has(l.id))).toBe(false);
  expect(found.flatMap((j) => j.lines).every((l) => ownAccountIds.has(l.accountId))).toBe(true);

  const lines = tx.linesInRange(t.period.startDate, t.period.endDate);
  const activeIds = own.journals.filter((j) => j.status === "active").map((j) => j.id);
  expect(sorted(lines.map((l) => l.journalId))).toEqual(sorted(activeIds));
  expect(lines.every((l) => ownAccountIds.has(l.accountId))).toBe(true);

  const opening = tx.openingBalances(t.period.fiscalYear);
  expect(sorted(opening.map((o) => o.id))).toEqual(sorted(own.opening.map((o) => o.id)));
  expect(opening.some((o) => otherOpeningIds.has(o.id))).toBe(false);
  expect(opening.every((o) => ownAccountIds.has(o.accountId))).toBe(true);
}

describe("テナントの分離（US6, FR-002, SC-007）", () => {
  it("事業体ごとに別の DB ファイルを持つ", () => {
    expect(a.entityId).not.toBe(b.entityId);
    expect(tenantFile(a.entityId)).not.toBe(tenantFile(b.entityId));
    expect(existsSync(tenantFile(a.entityId))).toBe(true);
    expect(existsSync(tenantFile(b.entityId))).toBe(true);
  });

  it("2つのテナントに任意の仕訳・期首残高を登録しても、それぞれの読み取りは自分のデータだけを返す", () => {
    fc.assert(
      fc.property(fc.tuple(tenantDataArb(a), tenantDataArb(b)), ([dataA, dataB]) => {
        withSeeds(a, dataA, (txA, savedA) => {
          withSeeds(b, dataB, (txB, savedB) => {
            expectOnlyOwn(a, txA, savedA, savedB);
            expectOnlyOwn(b, txB, savedB, savedA);
          });
        });
      }),
      { numRuns: 30 },
    );
  });

  it("他方のテナントの科目・ID で検索しても、何も返さない", () => {
    fc.assert(
      fc.property(fc.tuple(tenantDataArb(a), tenantDataArb(b)), ([dataA, dataB]) => {
        withSeeds(a, dataA, (txA, savedA) => {
          withSeeds(b, dataB, (txB) => {
            for (const account of a.masters.listAccounts()) {
              expect(
                txB.findJournals({ accountId: account.id, includeVoided: true }).items,
              ).toEqual([]);
            }
            for (const journal of savedA.journals) {
              expect(txB.getJournal(journal.id)).toBeUndefined();
              expect(txA.getJournal(journal.id)?.id).toBe(journal.id);
            }
          });
        });
      }),
      { numRuns: 15 },
    );
  });
});
