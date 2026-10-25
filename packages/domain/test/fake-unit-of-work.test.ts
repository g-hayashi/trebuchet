import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NewJournal } from "../src/ports.ts";
import { domainError, err, type InvoicingAuditEntry, ok } from "../src/types.ts";
import {
  fakeClosingUnitOfWork,
  fakeImportUnitOfWork,
  fakeInvoicingUnitOfWork,
  fakeRecurringUnitOfWork,
} from "./fakes.ts";

// TenantUnitOfWork のフェイク（FakeUnitOfWork）の巻き戻し。db の実装と同じ性質を持つことを確かめる:
// fn が ok を返せば確定し、err を返すか例外を投げれば fn の中の書き込みをすべて巻き戻す

const AT = "2026-10-24T00:00:00.000Z";

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

describe("FakeUnitOfWork（TenantUnitOfWork の性質）", () => {
  it("ok なら fn の書き込みが残り、err・例外なら run の前の状態に戻る（err と例外はそのまま返す・投げる）", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 5 }),
        fc.array(opArb, { maxLength: 5 }),
        outcomeArb,
        (committed, attempted, outcome) => {
          const uow = fakeInvoicingUnitOfWork();
          let seq = 0;
          const apply = (
            tx: Parameters<Parameters<typeof uow.run>[0]>[0],
            ops: Op[],
            prefix: string,
          ) => {
            for (const op of ops) {
              seq += 1;
              if (op === "tag") tx.masters.insertTag({ id: `${prefix}-t${seq}`, name: `t${seq}` });
              if (op === "journal") tx.ledger.insertJournal(journal(`${prefix}-j${seq}`, seq));
              if (op === "audit") tx.invoicing.appendInvoicingAudit(audit(`${prefix}-a${seq}`));
            }
          };
          const first = uow.run((tx) => {
            apply(tx, committed, "c");
            return ok("committed");
          });
          expect(first).toEqual(ok("committed"));
          const state = () =>
            structuredClone({
              ledger: uow.ledger.state,
              masters: uow.masters.state,
              invoicing: uow.invoicing.state,
            });
          const before = state();
          const boom = new Error("途中で失敗");
          const call = () =>
            uow.run((tx) => {
              apply(tx, attempted, "x");
              if (outcome === "err") return err(failure);
              if (outcome === "throw") throw boom;
              return ok(attempted.length);
            });

          if (outcome === "throw") {
            expect(call).toThrow(boom);
            expect(state()).toEqual(before);
            return;
          }
          const result = call();
          if (outcome === "err") {
            expect(result).toEqual(err(failure));
            expect(state()).toEqual(before);
            return;
          }
          expect(result).toEqual(ok(attempted.length));
          const count = (op: Op) => attempted.filter((o) => o === op).length;
          expect(uow.masters.listTags()).toHaveLength(before.masters.tags.length + count("tag"));
          expect(uow.ledger.journals).toHaveLength(
            before.ledger.journals.length + count("journal"),
          );
          expect(uow.invoicing.audits).toHaveLength(
            before.invoicing.audits.length + count("audit"),
          );
        },
      ),
    );
  });

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

  it("同じ UnitOfWork の run の中で run を呼ぶと例外（db では入れ子のトランザクションにならない）", () => {
    const uow = fakeInvoicingUnitOfWork();
    expect(() => uow.run(() => uow.run(() => ok(1)))).toThrow(/入れ子/);
    expect(uow.run(() => ok(2))).toEqual(ok(2));
  });

  it.each([
    [
      "取込",
      () => {
        const uow = fakeImportUnitOfWork();
        return {
          uow,
          write: () =>
            uow.run(({ imports }) => {
              imports.upsertAccountMappings([{ sourceName: "現金", accountId: "a" }], AT);
              return err(failure);
            }),
          extra: () => uow.imports.listAccountMappings(),
        };
      },
    ],
    [
      "決算",
      () => {
        const uow = fakeClosingUnitOfWork();
        return {
          uow,
          write: () =>
            uow.run(({ closing }) => {
              closing.appendClosingAudit({
                ...audit("a-1"),
                targetType: "fixed_asset",
                action: "create",
              });
              return err(failure);
            }),
          extra: () => uow.closing.audits,
        };
      },
    ],
    [
      "請求",
      () => {
        const uow = fakeInvoicingUnitOfWork();
        return {
          uow,
          write: () =>
            uow.run(({ invoicing }) => {
              invoicing.appendInvoicingAudit(audit("a-1"));
              return err(failure);
            }),
          extra: () => uow.invoicing.audits,
        };
      },
    ],
    [
      "定期仕訳",
      () => {
        const uow = fakeRecurringUnitOfWork();
        return {
          uow,
          write: () =>
            uow.run(({ recurring }) => {
              recurring.appendRecurringAudit({ ...audit("a-1"), targetType: "recurring_run" });
              return err(failure);
            }),
          extra: () => uow.recurring.audits,
        };
      },
    ],
  ])("%s の UnitOfWork: 帳簿・マスタ・ストアに書いた後の err で全部が巻き戻る", (_, setup) => {
    const { uow, write, extra } = setup();
    const r = uow.run(({ ledger, masters }) => {
      masters.insertTag({ id: "t-1", name: "出張" });
      ledger.insertJournal(journal("j-1", 1));
      return ok(null);
    });
    expect(r).toEqual(ok(null));
    expect(write()).toEqual(err(failure));
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-1"]);
    expect(uow.masters.listTags().map((t) => t.id)).toEqual(["t-1"]);
    expect(extra()).toEqual([]);

    const r2 = uow.run(({ ledger, masters }) => {
      masters.insertTag({ id: "t-2", name: "会議" });
      ledger.insertJournal(journal("j-2", 2));
      return err(failure);
    });
    expect(r2).toEqual(err(failure));
    expect(uow.ledger.journals.map((j) => j.id)).toEqual(["j-1"]);
    expect(uow.masters.listTags().map((t) => t.id)).toEqual(["t-1"]);
  });
});
