import { randomUUIDv7 } from "node:crypto";
import {
  type FiscalPeriod,
  type Journal,
  type JournalDraft,
  type JournalQuery,
  type LedgerRepository,
  type NewJournal,
  validateJournal,
} from "@trebuchet/domain";
import { balancedLinesArb, dateInPeriodArb, fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant } from "../src/tenant-store.ts";
import { createTestEntity, NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;
let period: FiscalPeriod;
let accountIds: string[];
let partnerIds: string[];
let tagIds: string[];

const clock = { now: () => NOW };

beforeEach(() => {
  tmp = useTempDataDir("search");
  const db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
  const first = masters.listFiscalPeriods()[0];
  if (first === undefined) throw new Error("会計期間がない");
  period = first;
  // 条件に一致しやすいよう、科目・取引先・タグは少数にする
  accountIds = masters
    .listAccounts()
    .filter((a) => ["現金", "普通預金", "売掛金", "売上高", "地代家賃"].includes(a.name))
    .map((a) => a.id);
  partnerIds = ["A社", "B社", "C社"].map((name) => {
    const id = randomUUIDv7();
    masters.insertPartner({ id, name, honorific: null, memo: null, isActive: true });
    return id;
  });
  tagIds = ["定期", "源泉", "按分"].map((name) => {
    const id = randomUUIDv7();
    masters.insertTag({ id, name });
    return id;
  });
});
afterEach(() => tmp.cleanup());

const WORDS = ["家賃", "電気代", "10月分の売上", "交通費 Suica", "ABC", "abc"];

type Seed = { draft: JournalDraft; voided: boolean };

function seedArb(): fc.Arbitrary<Seed[]> {
  const accounts = masters.listAccounts().filter((a) => accountIds.includes(a.id));
  const lineExtraArb = fc.record({
    partnerId: fc.option(fc.constantFrom(...partnerIds), { nil: undefined }),
    description: fc.option(fc.constantFrom(...WORDS), { nil: undefined }),
    tagIds: fc.subarray(tagIds),
  });
  const journalArb = fc
    .record({
      date: dateInPeriodArb(period),
      memo: fc.option(fc.constantFrom(...WORDS), { nil: undefined }),
      lines: balancedLinesArb(accounts),
      voided: fc.boolean(),
    })
    .chain((j) =>
      fc
        .array(lineExtraArb, { minLength: j.lines.length, maxLength: j.lines.length })
        .map((extras) => ({
          voided: j.voided,
          draft: {
            date: j.date,
            memo: j.memo,
            lines: j.lines.map((l, i) => ({ ...l, ...extras[i] })),
          },
        })),
    );
  return fc.array(journalArb, { maxLength: 40 });
}

/** 生成した仕訳の金額・日付から条件を選び、一致する仕訳がある条件も作られやすくする */
function queryArb(seeds: Seed[]): fc.Arbitrary<JournalQuery> {
  const amounts = seeds.flatMap((s) => s.draft.lines.map((l) => l.amount));
  const amountArb =
    amounts.length > 0
      ? fc.oneof(fc.constantFrom(...amounts), fc.integer({ min: 1, max: 1_000_000_000 }))
      : fc.integer({ min: 1, max: 1_000_000_000 });
  const opt = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined, freq: 2 });
  return fc.record({
    dateFrom: opt(dateInPeriodArb(period)),
    dateTo: opt(dateInPeriodArb(period)),
    amountMin: opt(amountArb),
    amountMax: opt(amountArb),
    partnerId: opt(fc.constantFrom(...partnerIds, randomUUIDv7())),
    accountId: opt(fc.constantFrom(...accountIds)),
    q: opt(fc.constantFrom("家賃", "月分", "Suica", "abc", "ABC", " ", "")),
    tagId: opt(fc.constantFrom(...tagIds)),
    includeVoided: opt(fc.boolean()),
  });
}

/** メモリ上のオラクル: 条件に合う仕訳を、日付の降順・同じ日付は仕訳番号の降順で返す */
function oracle(journals: readonly Journal[], q: JournalQuery): Journal[] {
  const text = q.q?.trim() ?? "";
  const lineMatches = (j: Journal, pred: (l: Journal["lines"][number]) => boolean) =>
    j.lines.some(pred);
  return journals
    .filter((j) => q.includeVoided === true || j.status === "active")
    .filter((j) => q.dateFrom === undefined || j.date >= q.dateFrom)
    .filter((j) => q.dateTo === undefined || j.date <= q.dateTo)
    .filter(
      (j) =>
        (q.amountMin === undefined && q.amountMax === undefined) ||
        lineMatches(
          j,
          (l) =>
            (q.amountMin === undefined || l.amount >= q.amountMin) &&
            (q.amountMax === undefined || l.amount <= q.amountMax),
        ),
    )
    .filter((j) => q.partnerId === undefined || lineMatches(j, (l) => l.partnerId === q.partnerId))
    .filter((j) => q.accountId === undefined || lineMatches(j, (l) => l.accountId === q.accountId))
    .filter((j) => q.tagId === undefined || lineMatches(j, (l) => l.tagIds.includes(q.tagId ?? "")))
    .filter(
      (j) =>
        text === "" ||
        (j.memo ?? "").includes(text) ||
        lineMatches(j, (l) => (l.description ?? "").includes(text)),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.journalNo - a.journalNo);
}

class Rollback extends Error {}

/** 仕訳群を登録して fn を実行し、最後にロールバックする（実行ごとに空の帳簿から始める） */
function withSeeds(seeds: Seed[], fn: (tx: LedgerRepository, all: Journal[]) => void) {
  const ctx = {
    accounts: masters.listAccounts(),
    subAccounts: masters.listSubAccounts(),
    partners: masters.listPartners(),
    tags: masters.listTags(),
    periods: masters.listFiscalPeriods(),
    taxSettings: masters.listTaxSettings(),
    taxRates: masters.listTaxRates(),
  };
  try {
    ledger.transaction((tx) => {
      const all = seeds.map(({ draft, voided }) => {
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
      fn(tx, all);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const idsOf = (journals: readonly Journal[]) => journals.map((j) => j.journalNo);

describe("findJournals（US3, FR-023, SC-006）", () => {
  it("任意の条件の組み合わせで、結果がオラクルのフィルターと一致する（漏れも余分もない）", () => {
    fc.assert(
      fc.property(
        seedArb().chain((seeds) =>
          fc.tuple(fc.constant(seeds), fc.array(queryArb(seeds), { minLength: 1, maxLength: 8 })),
        ),
        ([seeds, queries]) => {
          withSeeds(seeds, (tx, all) => {
            for (const query of queries) {
              const page = tx.findJournals({ ...query, limit: 200 });
              expect(idsOf(page.items)).toEqual(idsOf(oracle(all, query)));
              expect(page.nextCursor).toBeNull();
            }
          });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("cursor で全ページをたどると、重複も欠落もなく同じ順に並ぶ", () => {
    fc.assert(
      fc.property(
        seedArb().chain((seeds) =>
          fc.tuple(fc.constant(seeds), queryArb(seeds), fc.integer({ min: 1, max: 7 })),
        ),
        ([seeds, query, limit]) => {
          withSeeds(seeds, (tx, all) => {
            const expected = oracle(all, query);
            const collected: Journal[] = [];
            let cursor: string | undefined;
            for (let i = 0; i <= all.length + 1; i += 1) {
              const page = tx.findJournals({ ...query, limit, cursor });
              expect(page.items.length).toBeLessThanOrEqual(limit);
              collected.push(...page.items);
              if (page.nextCursor === null) break;
              cursor = page.nextCursor;
            }
            expect(idsOf(collected)).toEqual(idsOf(expected));
          });
        },
      ),
      { numRuns: 40 },
    );
  });

  it("返す仕訳は行とタグを含む（getJournal と同じ内容）", () => {
    withSeeds(
      fc.sample(seedArb(), 1)[0]?.map((s) => ({ ...s, voided: false })) ?? [],
      (tx, all) => {
        const page = tx.findJournals({ includeVoided: true, limit: 200 });
        expect(page.items).toEqual(oracle(all, { includeVoided: true }));
      },
    );
  });

  it("limit の既定は 50", () => {
    const seeds = fc.sample(seedArb(), 30).flat().slice(0, 60);
    withSeeds(
      seeds.map((s) => ({ ...s, voided: false })),
      (tx, all) => {
        const page = tx.findJournals({});
        expect(page.items).toHaveLength(Math.min(50, all.length));
        expect(page.nextCursor === null).toBe(all.length <= 50);
      },
    );
  });
});
