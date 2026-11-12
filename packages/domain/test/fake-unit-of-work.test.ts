import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NewJournal, TenantTx } from "../src/ports.ts";
import { domainError, err, type InvoicingAuditEntry, ok, type Result } from "../src/types.ts";
import {
  type FakeUnitOfWorkOf,
  fakeClosingUnitOfWork,
  fakeImportUnitOfWork,
  fakeInvoicingUnitOfWork,
  fakeRecurringUnitOfWork,
  fakeStatementUnitOfWork,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
} from "./fakes.ts";
import { NOW as AT } from "./test-dates.ts";

// TenantUnitOfWork のフェイク（FakeUnitOfWork）の巻き戻しの契約。db の実装（db の unit-of-work.test.ts）と
// 同じ性質を、機能ごとのフェイク（取込・決算・請求・定期仕訳・明細）すべてに確かめる:
// fn が ok を返せば確定し、err を返すか例外を投げれば fn の中の書き込みをすべて巻き戻す。
// 機能ごとのフェイクのテストには、その機能に固有の検査だけを置く

const journal = (id: string, journalNo: number): NewJournal => ({
  id,
  journalNo,
  date: "2026-10-31",
  fiscalPeriodId: "period-2026",
  memo: null,
  correctsJournalId: null,
  source: "manual",
  createdAt: AT,
  lines: [
    {
      id: `${id}-1`,
      lineNo: 1,
      side: "debit",
      accountId: "a",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: `${id}-2`,
      lineNo: 2,
      side: "credit",
      accountId: "b",
      subAccountId: null,
      amount: 100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
});

const audit = (id: string): InvoicingAuditEntry => ({
  id,
  occurredAt: AT,
  targetType: "invoice",
  targetId: "inv-1",
  action: "create",
  reason: null,
  beforeJson: null,
  afterJson: "{}",
});

type Op = "tag" | "journal" | "audit";
type Outcome = "ok" | "err" | "throw";

const opArb = fc.constantFrom<Op>("tag", "journal", "audit");
const outcomeArb = fc.constantFrom<Outcome>("ok", "err", "throw");

const failure = domainError("VALIDATION", "中止", { field: "x" });

type Body = (tx: TenantTx<object>, writeStore: (id: string) => void) => Result<number>;

/** 機能ごとのフェイクの UnitOfWork。`writeStore` は、その機能のストアへの 1 回の書き込み */
type Kind = {
  name: string;
  open: () => {
    run: (body: Body) => Result<number>;
    nested: () => unknown;
    /** 帳簿・マスタ・全ストアの状態の複製 */
    state: () => unknown;
    counts: () => { tags: number; journals: number; store: number };
  };
};

function kind<S extends Record<string, { state: unknown }>>(
  name: string,
  make: () => FakeUnitOfWorkOf<S>,
  writeStore: (tx: TenantTx<S>, id: string) => void,
  storeCount: (uow: FakeUnitOfWorkOf<S>) => number,
): Kind {
  return {
    name,
    open: () => {
      const uow = make();
      return {
        run: (body) => uow.run((tx) => body(tx, (id) => writeStore(tx, id))),
        nested: () => uow.run(() => uow.run(() => ok(1))),
        state: () =>
          structuredClone({
            ledger: uow.ledger.state,
            masters: uow.masters.state,
            stores: Object.values(uow.stores).map((s) => s.state),
          }),
        counts: () => ({
          tags: uow.masters.listTags().length,
          journals: uow.ledger.journals.length,
          store: storeCount(uow),
        }),
      };
    },
  };
}

const KINDS: Kind[] = [
  kind(
    "取込",
    fakeImportUnitOfWork,
    (tx, id) => tx.imports.upsertAccountMappings([{ sourceName: `科目${id}`, accountId: "a" }], AT),
    (uow) => uow.imports.listAccountMappings().length,
  ),
  kind(
    "決算",
    fakeClosingUnitOfWork,
    (tx, id) =>
      tx.closing.appendClosingAudit({ ...audit(id), targetType: "fixed_asset", action: "create" }),
    (uow) => uow.closing.audits.length,
  ),
  kind(
    "請求",
    fakeInvoicingUnitOfWork,
    (tx, id) => {
      tx.invoicing.appendInvoicingAudit(audit(id));
      tx.invoicing.registerOrigin(`j-${id}`, {
        kind: "invoice",
        invoiceId: "inv-1",
        invoiceNo: "2026-1031-001",
      });
    },
    (uow) => uow.invoicing.audits.length,
  ),
  kind(
    "定期仕訳",
    fakeRecurringUnitOfWork,
    (tx, id) => tx.recurring.appendRecurringAudit({ ...audit(id), targetType: "recurring_run" }),
    (uow) => uow.recurring.audits.length,
  ),
  kind(
    "明細",
    fakeStatementUnitOfWork,
    (tx, id) =>
      tx.statements.appendStatementAudit({
        ...audit(id),
        targetType: "statement",
        action: "create",
      }),
    (uow) => uow.statements.audits.length,
  ),
];

describe.each(KINDS)("$name の UnitOfWork（FakeUnitOfWork の契約）", ({ open }) => {
  it("ok なら fn の書き込みが残り、err・例外なら run の前の状態に戻る（err と例外はそのまま返す・投げる）", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 5 }),
        fc.array(opArb, { maxLength: 5 }),
        outcomeArb,
        (committed, attempted, outcome) => {
          const uow = open();
          let seq = 0;
          const apply = (
            tx: TenantTx<object>,
            writeStore: (id: string) => void,
            ops: Op[],
            prefix: string,
          ) => {
            for (const op of ops) {
              seq += 1;
              if (op === "tag") tx.masters.insertTag({ id: `${prefix}-t${seq}`, name: `t${seq}` });
              if (op === "journal") tx.ledger.insertJournal(journal(`${prefix}-j${seq}`, seq));
              if (op === "audit") writeStore(`${prefix}-a${seq}`);
            }
          };
          const first = uow.run((tx, writeStore) => {
            apply(tx, writeStore, committed, "c");
            return ok(committed.length);
          });
          expect(first).toEqual(ok(committed.length));
          const before = uow.state();
          const beforeCounts = uow.counts();
          const boom = new Error("途中で失敗");
          const call = () =>
            uow.run((tx, writeStore) => {
              apply(tx, writeStore, attempted, "x");
              if (outcome === "err") return err(failure);
              if (outcome === "throw") throw boom;
              return ok(attempted.length);
            });

          if (outcome === "throw") {
            expect(call).toThrow(boom);
            expect(uow.state()).toEqual(before);
            return;
          }
          const result = call();
          if (outcome === "err") {
            expect(result).toEqual(err(failure));
            expect(uow.state()).toEqual(before);
            return;
          }
          expect(result).toEqual(ok(attempted.length));
          const count = (op: Op) => attempted.filter((o) => o === op).length;
          expect(uow.counts()).toEqual({
            tags: beforeCounts.tags + count("tag"),
            journals: beforeCounts.journals + count("journal"),
            store: beforeCounts.store + count("audit"),
          });
        },
      ),
    );
  });

  it("同じ UnitOfWork の run の中で run を呼ぶと例外（db では入れ子のトランザクションにならない）", () => {
    const uow = open();
    expect(() => uow.nested()).toThrow(/入れ子/);
    expect(uow.run(() => ok(2))).toEqual(ok(2));
  });
});

describe("FakeUnitOfWork（請求のフェイクでの入れ子の ledger.transaction）", () => {
  it("内側の ledger.transaction の例外は内側だけを巻き戻し、外側が ok なら外側の書き込みは確定する", () => {
    const uow = fakeInvoicingUnitOfWork();
    const r = uow.run(({ ledger }) => {
      ledger.insertJournal(journal("j-1", 1));
      expect(() =>
        ledger.transaction((tx) => {
          tx.insertJournal(journal("j-2", 2));
          throw new Error("内側の失敗");
        }),
      ).toThrow("内側の失敗");
      return ok(null);
    });
    expect(r).toEqual(ok(null));
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-1"]);
  });
});

describe("リポジトリ 1 つの transaction のフェイク（db と同じ性質）", () => {
  it("InMemoryLedgerRepository・InMemoryMasterRepository: ok なら残り、err・例外なら前の状態に戻る", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), outcomeArb, (writes, outcome) => {
        const ledger = new InMemoryLedgerRepository();
        const masters = new InMemoryMasterRepository();
        const boom = new Error("途中で失敗");
        const finish = (n: number) => {
          if (outcome === "err") return err(failure);
          if (outcome === "throw") throw boom;
          return ok(n);
        };
        const before = structuredClone({ ledger: ledger.state, masters: masters.state });
        const runLedger = () =>
          ledger.transaction((tx) => {
            for (let i = 0; i < writes; i += 1) tx.insertJournal(journal(`j-${i}`, i + 1));
            return finish(writes);
          });
        const runMasters = () =>
          masters.transaction((tx) => {
            for (let i = 0; i < writes; i += 1) tx.insertTag({ id: `t-${i}`, name: `t${i}` });
            return finish(writes);
          });
        if (outcome === "throw") {
          expect(runLedger).toThrow(boom);
          expect(runMasters).toThrow(boom);
        } else {
          const expected = outcome === "err" ? err(failure) : ok(writes);
          expect(runLedger()).toEqual(expected);
          expect(runMasters()).toEqual(expected);
        }
        const after = structuredClone({ ledger: ledger.state, masters: masters.state });
        if (outcome === "ok") {
          expect(after.ledger.journals).toHaveLength(writes);
          expect(after.masters.tags).toHaveLength(writes);
        } else {
          expect(after).toEqual(before);
        }
      }),
    );
  });
});
