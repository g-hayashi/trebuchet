import { randomUUIDv7 } from "node:crypto";
import {
  err,
  type JournalChainRef,
  type LedgerRepository,
  type NewJournal,
  validateJournal,
  validationError,
} from "@trebuchet/domain";
import { fc } from "@trebuchet/domain/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleLedgerRepository } from "../src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { openTenant } from "../src/tenant-store.ts";
import {
  accountIdOf,
  createTestEntity,
  NOW,
  type TempDataDir,
  useTempDataDir,
} from "../src/testing.ts";

// `correctionChains`（根の仕訳から訂正の連鎖を再帰の CTE で一括に読む）が、仕訳ごとに getJournal と
// correctingJournalsOf でたどった結果と同じこと（006 R15 の状態の導出に使う）

let tmp: TempDataDir;
let masters: DrizzleMasterRepository;
let ledger: DrizzleLedgerRepository;

beforeEach(() => {
  tmp = useTempDataDir("ledger-chains");
  const db = openTenant(createTestEntity().id);
  masters = new DrizzleMasterRepository(db);
  ledger = new DrizzleLedgerRepository(db);
});
afterEach(() => tmp.cleanup());

/** 訂正元つきの仕訳（行は 2 行の同じ形） */
function journalOf(journalNo: number, correctsJournalId: string | null): NewJournal {
  const valid = validateJournal(
    {
      date: "2026-05-10",
      lines: [
        { side: "debit", accountId: accountIdOf(masters, "消耗品費"), amount: 1_000 },
        { side: "credit", accountId: accountIdOf(masters, "普通預金"), amount: 1_000 },
      ],
    },
    {
      accounts: masters.listAccounts(),
      subAccounts: masters.listSubAccounts(),
      partners: masters.listPartners(),
      tags: masters.listTags(),
      periods: masters.listFiscalPeriods(),
      taxSettings: masters.listTaxSettings(),
      taxRates: masters.listTaxRates(),
    },
  );
  if (!valid.ok) throw new Error(JSON.stringify(valid.error));
  return {
    ...valid.value,
    correctsJournalId,
    id: randomUUIDv7(),
    journalNo,
    createdAt: NOW,
    lines: valid.value.lines.map((l) => ({ ...l, id: randomUUIDv7() })),
  };
}

/** 変更前のたどり方（仕訳ごとに getJournal と correctingJournalsOf） */
function chainsByWalking(repo: LedgerRepository, rootIds: readonly string[]): JournalChainRef[] {
  const found = new Map<string, JournalChainRef>();
  const stack = [...rootIds];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (found.has(id)) continue;
    const journal = repo.getJournal(id);
    if (journal === undefined) continue;
    found.set(id, {
      id: journal.id,
      status: journal.status,
      correctsJournalId: journal.correctsJournalId,
    });
    for (const c of repo.correctingJournalsOf(id)) stack.push(c.id);
  }
  return [...found.values()];
}

const sorted = (refs: readonly JournalChainRef[]) =>
  [...refs].sort((a, b) => a.id.localeCompare(b.id));

/** 仕訳の森: i 番目の仕訳の訂正元（i より前の番号か、なし）と取消の有無 */
const forestArb = fc.array(
  fc.record({ parent: fc.option(fc.nat(), { freq: 3 }), voided: fc.boolean() }),
  { minLength: 1, maxLength: 14 },
);

/** 仕訳の森を書き、ID を返す（呼ぶ側のトランザクションの中で） */
function writeForest(
  repo: LedgerRepository,
  forest: readonly { parent: number | null; voided: boolean }[],
): string[] {
  const ids: string[] = [];
  for (const [i, node] of forest.entries()) {
    const parent = node.parent === null || i === 0 ? null : (ids[node.parent % i] ?? null);
    const saved = repo.insertJournal(journalOf(repo.nextJournalNo(), parent));
    if (node.voided) repo.voidJournal(saved.id, saved.version, NOW);
    ids.push(saved.id);
  }
  return ids;
}

describe("DrizzleLedgerRepository.correctionChains", () => {
  it("どの訂正の森・どの根の集まり（重複・知らない ID を含む）でも、仕訳ごとにたどった結果と同じ", () => {
    let nonTrivial = 0;
    fc.assert(
      fc.property(
        forestArb,
        fc.array(fc.nat(), { maxLength: 6 }),
        fc.boolean(),
        (forest, rootPicks, withUnknown) => {
          // 1 回ごとに巻き戻す（`err` を返すとトランザクションを戻す）
          ledger.transaction((tx) => {
            const ids = writeForest(tx, forest);
            const roots = rootPicks.map((p) => ids[p % ids.length] as string);
            if (withUnknown) roots.push(randomUUIDv7());
            const expected = chainsByWalking(tx, roots);
            expect(sorted(tx.correctionChains(roots))).toEqual(sorted(expected));
            if (expected.length > new Set(roots).size) nonTrivial += 1;
            return err(validationError("巻き戻す"));
          });
        },
      ),
      { numRuns: 30 },
    );
    // 空振りでない（根より先の訂正までたどる場合がある）
    expect(nonTrivial).toBeGreaterThan(0);
  });

  it("根が 1 回の問い合わせの数を超えても、全部の連鎖を重複なく返す", () => {
    const ids = writeForest(
      ledger,
      Array.from({ length: 1_200 }, (_, i) => ({
        parent: i % 3 === 0 ? null : i - 1,
        voided: i % 2 === 0,
      })),
    );
    const roots = [...ids, ...ids.slice(0, 10)];
    const chains = ledger.correctionChains(roots);
    expect(chains).toHaveLength(ids.length);
    expect(sorted(chains)).toEqual(sorted(chainsByWalking(ledger, roots)));
    // 3 件ずつの連鎖の先頭だけを根にしても、訂正の訂正までたどる
    expect(ledger.correctionChains(ids.filter((_, i) => i % 3 === 0))).toHaveLength(ids.length);
    expect(ledger.correctionChains([])).toEqual([]);
  });
});
