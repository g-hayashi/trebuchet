import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JournalDraft } from "../../src/types.ts";
import { correctJournal } from "../../src/usecases/correct-journal.ts";
import { createJournal } from "../../src/usecases/create-journal.ts";
import {
  createJournalFromReceipt,
  linkReceipt,
  unlinkReceipt,
} from "../../src/usecases/receipt-links.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { seedReceipt, setupReceiptsWithLedger } from "../receipt-setup.ts";

// INV-64（結びつき。data-model §4）: 有効な結びつきは証憑ごとに高々 1 件、削除済みにはない、
// 有効な結びつきの仕訳は存在する、仕訳の訂正・取消の後も同じ journal_id、失敗は全部戻る、帳簿を変えない

const RECEIPTS = 3; // 添字 3 は削除済みの証憑
const JOURNALS = 3;

type Op =
  | { kind: "link"; r: number; j: number; replace: boolean; reason: boolean }
  | { kind: "unlink"; r: number; reason: boolean }
  | { kind: "void"; j: number }
  | { kind: "correct"; j: number }
  | { kind: "create"; r: number; failAt: number | null };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("link" as const),
    r: fc.integer({ min: 0, max: RECEIPTS }),
    j: fc.integer({ min: 0, max: JOURNALS - 1 }),
    replace: fc.boolean(),
    reason: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("unlink" as const),
    r: fc.integer({ min: 0, max: RECEIPTS }),
    reason: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("void" as const), j: fc.integer({ min: 0, max: JOURNALS - 1 }) }),
  fc.record({
    kind: fc.constant("correct" as const),
    j: fc.integer({ min: 0, max: JOURNALS - 1 }),
  }),
  fc.record({
    kind: fc.constant("create" as const),
    r: fc.integer({ min: 0, max: RECEIPTS }),
    failAt: fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
  }),
);

function build() {
  const ctx = setupReceiptsWithLedger();
  const draft = (date: string, amount: number): JournalDraft => ({
    date,
    lines: [
      { side: "debit", accountId: ctx.accountId("消耗品費"), amount },
      { side: "credit", accountId: ctx.accountId("普通預金"), amount },
    ],
  });
  const ledgerDeps = { ledger: ctx.ledger, masters: ctx.masters, ids: ctx.ids, clock: ctx.clock };
  const receipts = Array.from({ length: RECEIPTS + 1 }, (_, i) =>
    seedReceipt(ctx.uow, {
      id: `r-${i}`,
      ...(i === RECEIPTS ? { deletedAt: "2026-10-30T00:00:00.000Z" } : {}),
    }),
  );
  const journalIds: string[] = [];
  for (let j = 0; j < JOURNALS; j++) {
    const created = createJournal(ledgerDeps, draft(`2026-10-${20 + j}`, 1000 + j));
    if (!created.ok) throw new Error(created.error.message);
    journalIds.push(created.value.journal.id);
  }
  const fault = new FaultInjectingReceiptUnitOfWork(ctx.uow);
  return { ctx, draft, ledgerDeps, receipts, journalIds, deps: { ...ctx.deps, uow: fault }, fault };
}

describe("INV-64: 結びつけ・解除・仕訳の訂正・取消・証憑から仕訳の登録の列", () => {
  it("モデルと一致し、不変条件を守り、失敗は何も残さず、結びつきの操作は帳簿を変えない", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
        const { ctx, draft, ledgerDeps, receipts, journalIds, deps, fault } = build();
        /** モデル: 証憑の添字 → 有効な結びつきの仕訳 ID */
        const model = new Map<number, string>();
        const status = (id: string) => ctx.ledger.getJournal(id)?.status;

        for (const [n, op] of ops.entries()) {
          ctx.clock.value = `2026-11-01T00:00:${String(n).padStart(2, "0")}.000Z`;
          fault.failAt = null;
          const before = receiptSnapshotOf(ctx.uow);

          if (op.kind === "void") {
            const id = journalIds[op.j] as string;
            const j = ctx.ledger.getJournal(id);
            if (j !== undefined && j.status === "active") {
              voidJournal(ledgerDeps, id, { reason: "取消", version: j.version });
            }
          } else if (op.kind === "correct") {
            const id = journalIds[op.j] as string;
            const j = ctx.ledger.getJournal(id);
            if (j !== undefined && j.status === "active") {
              const corrected = correctJournal(ledgerDeps, id, {
                ...draft(j.date, 5000 + n),
                reason: "訂正",
                version: j.version,
              });
              expect(corrected.ok).toBe(true);
              expect(ctx.ledger.getJournal(id)?.id).toBe(id);
            }
          } else {
            const receipt = receipts[op.r];
            if (receipt === undefined) throw new Error("receipt");
            const deleted = op.r === RECEIPTS;
            const current = model.get(op.r);
            const currentLive = current !== undefined && status(current) === "active";

            if (op.kind === "link") {
              const target = journalIds[op.j] as string;
              const result = linkReceipt(deps, receipt.id, {
                journalId: target,
                replace: op.replace,
                ...(op.reason ? { reason: "付替の理由" } : {}),
              });
              const expected = deleted
                ? "RECEIPT_DELETED"
                : status(target) === "voided"
                  ? "JOURNAL_VOIDED"
                  : current === target
                    ? undefined
                    : currentLive
                      ? !op.replace
                        ? "RECEIPT_ALREADY_LINKED"
                        : !op.reason
                          ? "REASON_REQUIRED"
                          : undefined
                      : undefined;
              expect(result.ok ? undefined : result.error.code).toBe(expected);
              if (result.ok) model.set(op.r, target);
              expect(ctx.ledger.state).toEqual(before.ledger); // 結びつきは帳簿を変えない
            } else if (op.kind === "unlink") {
              const result = unlinkReceipt(deps, receipt.id, {
                reason: op.reason ? "解除の理由" : " ",
              });
              const expected = deleted
                ? "RECEIPT_DELETED"
                : !op.reason
                  ? "REASON_REQUIRED"
                  : current === undefined
                    ? "VALIDATION"
                    : undefined;
              expect(result.ok ? undefined : result.error.code).toBe(expected);
              if (result.ok) model.delete(op.r);
              expect(ctx.ledger.state).toEqual(before.ledger);
            } else {
              fault.failAt = op.failAt;
              let outcome: { ok: boolean; code?: string; journalId?: string } | "threw";
              try {
                const result = createJournalFromReceipt(deps, receipt.id, {
                  journal: draft("2026-10-25", 2500),
                });
                outcome = result.ok
                  ? { ok: true, journalId: result.value.journal.id }
                  : { ok: false, code: result.error.code };
              } catch {
                outcome = "threw";
              }
              fault.failAt = null;
              if (outcome === "threw") {
                expect(receiptSnapshotOf(ctx.uow)).toEqual(before); // 途中の失敗は全部戻る
              } else if (!outcome.ok) {
                const expected = deleted
                  ? "RECEIPT_DELETED"
                  : currentLive
                    ? "RECEIPT_ALREADY_LINKED"
                    : undefined;
                expect(outcome.code).toBe(expected);
                expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
              } else {
                expect(deleted || currentLive).toBe(false);
                model.set(op.r, outcome.journalId as string);
                expect(ctx.ledger.state.journals).toHaveLength(before.ledger.journals.length + 1);
              }
            }
          }

          // ---- 不変条件 ----
          const all = ctx.uow.receipts.state.links;
          for (const [i, r] of receipts.entries()) {
            const active = all.filter((l) => l.receiptId === r.id && l.unlinkedAt === null);
            expect(active.length).toBeLessThanOrEqual(1);
            if (i === RECEIPTS) expect(active).toHaveLength(0);
            expect(active[0]?.journalId).toBe(model.get(i));
            for (const l of active) expect(ctx.ledger.getJournal(l.journalId)).toBeDefined();
          }
          for (const l of all) {
            // 閉じた結びつきは理由つき（unlinked_at と unlink_reason は同時に入る）
            expect(l.unlinkedAt === null).toBe(l.unlinkReason === null);
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it("行は減らない（結びつきの行・履歴の行は追記だけ）", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 20 }), (ops) => {
        const { ctx, receipts, journalIds, deps } = build();
        let links = 0;
        let audits = 0;
        for (const op of ops) {
          if (op.kind === "link") {
            linkReceipt(deps, (receipts[op.r] as { id: string }).id, {
              journalId: journalIds[op.j] as string,
              replace: op.replace,
              ...(op.reason ? { reason: "理由" } : {}),
            });
          } else if (op.kind === "unlink") {
            unlinkReceipt(deps, (receipts[op.r] as { id: string }).id, { reason: "理由" });
          }
          const state = ctx.uow.receipts.state;
          expect(state.links.length).toBeGreaterThanOrEqual(links);
          expect(state.audits.length).toBeGreaterThanOrEqual(audits);
          links = state.links.length;
          audits = state.audits.length;
        }
      }),
      { numRuns: 100 },
    );
  });
});
