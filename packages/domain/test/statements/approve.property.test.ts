import type { Purpose } from "@trebuchet/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Journal } from "../../src/types.ts";
import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  excludeStatement,
  unexcludeStatement,
} from "../../src/usecases/statement-approval.ts";
import { buildCandidates, listStatements } from "../../src/usecases/statements.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { FaultInjectingStatementUnitOfWork, snapshotOf } from "../statement-fault-injection.ts";
import { pastedRowArb, purposeArb } from "../statements-arbitraries.ts";
import { type StatementsCtx, setupStatements, unwrap } from "../statements-setup.ts";

// 006 T015。INV-41（承認以外の操作で仕訳帳・試算表が変わらない）、INV-43（結びつきは明細ごと・行ごとに高々 1 件）、
// INV-47 の承認の側（途中の失敗で全部巻き戻る）、突合（明細の口座の行の動きの合計 = 明細の金額）、
// 取消 → 再承認でも有効な結びつきは高々 1 件で registered

const rowsArb = fc.array(pastedRowArb, { minLength: 1, maxLength: 8 });

type Op =
  | { kind: "approveDraft"; idx: number; purpose: Purpose }
  | { kind: "approveCandidate"; idx: number }
  | { kind: "approveBulk" }
  | { kind: "void"; idx: number }
  | { kind: "exclude"; idx: number }
  | { kind: "unexclude"; idx: number }
  | { kind: "build" }
  | { kind: "ack"; idx: number };

const idxArb = fc.nat({ max: 20 });
const approvingOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("approveDraft" as const), idx: idxArb, purpose: purposeArb }),
  fc.record({ kind: fc.constant("approveCandidate" as const), idx: idxArb }),
  fc.constant({ kind: "approveBulk" as const }),
  fc.record({ kind: fc.constant("void" as const), idx: idxArb }),
);
const quietOpArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("exclude" as const), idx: idxArb }),
  fc.record({ kind: fc.constant("unexclude" as const), idx: idxArb }),
  fc.constant({ kind: "build" as const }),
  fc.record({ kind: fc.constant("ack" as const), idx: idxArb }),
);

function world(rows: Parameters<StatementsCtx["importRows"]>[0]): StatementsCtx {
  const ctx = setupStatements();
  ctx.mapAll();
  ctx.importRows(rows);
  return ctx;
}

const nth = (ctx: StatementsCtx, idx: number) => {
  const all = ctx.statements();
  return all[idx % all.length];
};

/** 失敗（Result の err）は無視する。例外は握りつぶさない */
function runOp(ctx: StatementsCtx, op: Op): void {
  const target = op.kind === "approveBulk" || op.kind === "build" ? undefined : nth(ctx, op.idx);
  switch (op.kind) {
    case "approveDraft": {
      if (target === undefined) return;
      const account = ctx.uow.statements.state.accounts.find(
        (a) => a.id === target.statementAccountId,
      );
      if (account?.usage === "private" && op.purpose === "private") return;
      approveCandidate(ctx.deps, target.id, { draft: ctx.shapeDraft(target.id, op.purpose) });
      return;
    }
    case "approveCandidate":
      if (target !== undefined) approveCandidate(ctx.deps, target.id);
      return;
    case "approveBulk":
      approveBulk(ctx.deps, { threshold: 0 });
      return;
    case "void": {
      const link = target === undefined ? undefined : ctx.activeLinks(target.id)[0];
      const journal = link === undefined ? undefined : ctx.ledger.getJournal(link.journalId);
      if (journal !== undefined) {
        voidJournal(ctx.ledgerDeps, journal.id, { reason: "取消", version: journal.version });
      }
      return;
    }
    case "exclude":
      if (target !== undefined) excludeStatement(ctx.deps, target.id, {});
      return;
    case "unexclude":
      if (target !== undefined) unexcludeStatement(ctx.deps, target.id, { reason: "戻す" });
      return;
    case "build":
      buildCandidates(ctx.deps, undefined, { rebuild: true });
      return;
    case "ack":
      if (target !== undefined) {
        ctx.uow.statements.markStatementChanged(target.id, JSON.stringify({ amount: 1 }));
        acknowledgeChange(ctx.deps, target.id);
      }
      return;
  }
}

const signed = (journal: Journal, lineId: string): number => {
  const line = journal.lines.find((l) => l.id === lineId);
  if (line === undefined) throw new Error("行がない");
  return line.side === "debit" ? line.amount : -line.amount;
};

/** 帳簿全体の科目別の借方・貸方の合計（有効な仕訳。試算表の中身） */
const trialBalance = (ctx: StatementsCtx) => {
  const sums = new Map<string, number>();
  for (const j of ctx.ledger.state.journals) {
    if (j.status !== "active") continue;
    for (const l of j.lines) {
      sums.set(`${l.accountId}:${l.side}`, (sums.get(`${l.accountId}:${l.side}`) ?? 0) + l.amount);
    }
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b));
};

/** INV-43・44・42・突合 */
function checkInvariants(ctx: StatementsCtx): void {
  const links = ctx.links();
  const active = links.filter((l) => l.revokedAt === null);
  // INV-43: 明細ごと・仕訳の行ごとに高々 1 件
  expect(new Set(active.map((l) => l.statementId)).size).toBe(active.length);
  expect(new Set(active.map((l) => l.journalLineId)).size).toBe(active.length);

  const views = new Map(unwrap(listStatements(ctx.deps)).map((v) => [v.id, v]));
  for (const s of ctx.statements()) {
    const mine = active.filter((l) => l.statementId === s.id);
    const registered = mine.some((l) => ctx.ledger.getJournal(l.journalId)?.status === "active");
    const expected = registered ? "registered" : s.excludedAt === null ? "unprocessed" : "excluded";
    expect(views.get(s.id)?.status).toBe(expected);
    if (!registered) continue;
    for (const l of mine) {
      const journal = ctx.ledger.getJournal(l.journalId);
      if (journal === undefined) throw new Error("仕訳がない");
      // 突合: 明細の口座の行（private は事業主貸・事業主借の行）の動き = 明細の金額
      expect(signed(journal, l.journalLineId)).toBe(s.amount);
      if (l.kind === "created") expect(journal.source).toBe("statement");
      // 貸借一致
      const debit = journal.lines
        .filter((x) => x.side === "debit")
        .reduce((a, x) => a + x.amount, 0);
      const credit = journal.lines
        .filter((x) => x.side === "credit")
        .reduce((a, x) => a + x.amount, 0);
      expect(debit).toBe(credit);
    }
  }
}

describe("承認の操作列（INV-42・43・44、突合）", () => {
  it("承認・取消・除外などのどんな列の後も、結びつきは明細ごと・行ごとに高々 1 件で、状態と金額の突合が合う", () => {
    fc.assert(
      fc.property(
        rowsArb,
        fc.array(fc.oneof(approvingOpArb, quietOpArb), { minLength: 1, maxLength: 12 }),
        (rows, ops) => {
          const ctx = world(rows);
          unwrap(buildCandidates(ctx.deps));
          for (const op of ops) {
            runOp(ctx, op);
            checkInvariants(ctx);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("承認 → 仕訳の取消 → 再承認を繰り返しても、有効な結びつきは高々 1 件で registered", () => {
    fc.assert(
      fc.property(
        pastedRowArb.filter((r) => r.accountName !== "テスト現金"),
        fc.array(purposeArb, { minLength: 1, maxLength: 3 }),
        (row, purposes) => {
          const ctx = world([row]);
          const id = ctx.idOf(row.content);
          for (const [i, purpose] of purposes.entries()) {
            unwrap(approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, purpose) }));
            expect(ctx.activeLinks(id)).toHaveLength(1);
            expect(ctx.links()).toHaveLength(i + 1);
            const view = unwrap(listStatements(ctx.deps)).find((v) => v.id === id);
            expect(view?.status).toBe("registered");
            const link = ctx.activeLinks(id)[0];
            const journal = ctx.ledger.getJournal(link?.journalId ?? "");
            if (journal === undefined) throw new Error("仕訳がない");
            unwrap(
              voidJournal(ctx.ledgerDeps, journal.id, { reason: "取消", version: journal.version }),
            );
            const back = unwrap(listStatements(ctx.deps)).find((v) => v.id === id);
            expect(back?.status).toBe("unprocessed");
          }
          unwrap(approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "business") }));
          expect(ctx.activeLinks(id)).toHaveLength(1);
          checkInvariants(ctx);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("INV-41: 承認以外の操作は仕訳帳と試算表を変えない", () => {
  it("取込・候補の作成・除外・除外の取消・変更の確認のどんな列の後も、帳簿は変わらない", () => {
    fc.assert(
      fc.property(
        rowsArb,
        fc.array(approvingOpArb, { maxLength: 5 }),
        fc.array(quietOpArb, { minLength: 1, maxLength: 12 }),
        rowsArb,
        (rows, setup, quiet, moreRows) => {
          const ctx = world(rows);
          unwrap(buildCandidates(ctx.deps));
          for (const op of setup) runOp(ctx, op); // 帳簿に仕訳がある状態にしておく
          const ledgerBefore = structuredClone(ctx.ledger.state.journals);
          const trialBefore = trialBalance(ctx);
          ctx.importRows(moreRows);
          for (const op of quiet) runOp(ctx, op);
          expect(ctx.ledger.state.journals).toEqual(ledgerBefore);
          expect(trialBalance(ctx)).toEqual(trialBefore);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("INV-47（承認の側）: 途中の失敗で全部巻き戻る", () => {
  it("任意の書き込みで失敗させると、仕訳・結びつき・失効・監査のどれも残らない。失敗しなければ registered", () => {
    let injected = 0;
    let succeeded = 0;
    fc.assert(
      fc.property(
        rowsArb,
        idxArb,
        purposeArb,
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 14 }),
        (rows, idx, purpose, viaCandidate, stale, failAt) => {
          let injector: FaultInjectingStatementUnitOfWork | undefined;
          const ctx = setupStatements({
            wrap: (inner) => {
              injector = new FaultInjectingStatementUnitOfWork(inner);
              return injector;
            },
          });
          ctx.mapAll();
          ctx.importRows(rows);
          unwrap(buildCandidates(ctx.deps));
          const target = nth(ctx, idx);
          if (target === undefined) return;
          const account = ctx.uow.statements.state.accounts.find(
            (a) => a.id === target.statementAccountId,
          );
          const candidate = ctx.uow.statements.state.candidates.find(
            (c) => c.statementId === target.id,
          );
          const canCandidate = candidate !== undefined && candidate.method !== "none";
          const useCandidate = viaCandidate && canCandidate;
          if (!useCandidate && account?.usage === "private" && purpose === "private") return;
          const input = useCandidate ? {} : { draft: ctx.shapeDraft(target.id, purpose) };

          if (stale) {
            // 一度承認して仕訳を取り消し、失効が要る状態にしておく
            const first = approveCandidate(ctx.deps, target.id, input);
            if (!first.ok || first.value.journal === null) return;
            const journal = first.value.journal;
            unwrap(
              voidJournal(ctx.ledgerDeps, journal.id, { reason: "取消", version: journal.version }),
            );
          }
          if (injector === undefined) throw new Error("injector");
          const before = snapshotOf(ctx.uow);
          injector.failAt = failAt;
          let result: ReturnType<typeof approveCandidate> | undefined;
          let thrown = false;
          try {
            result = approveCandidate(ctx.deps, target.id, input);
          } catch {
            thrown = true;
          }
          injector.failAt = null;
          if (thrown || result?.ok !== true) {
            if (thrown) injected += 1;
            expect(snapshotOf(ctx.uow)).toEqual(before);
          } else {
            succeeded += 1;
            const view = unwrap(listStatements(ctx.deps)).find((v) => v.id === target.id);
            expect(view?.status).toBe("registered");
            checkInvariants(ctx);
          }
        },
      ),
      { numRuns: 80 },
    );
    // 性質が空振りでない（失敗の注入も、成功の経路も通っている）
    expect(injected).toBeGreaterThan(0);
    expect(succeeded).toBeGreaterThan(0);
  });

  it("失敗した承認のあとで、同じ承認が成功する（明細は未処理のまま）", () => {
    const ctx0 = (() => {
      let injector: FaultInjectingStatementUnitOfWork | undefined;
      const ctx = setupStatements({
        wrap: (inner) => {
          injector = new FaultInjectingStatementUnitOfWork(inner);
          return injector;
        },
      });
      return { ctx, injector: () => injector as FaultInjectingStatementUnitOfWork };
    })();
    const { ctx } = ctx0;
    ctx.mapBank();
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    const draft = ctx.shapeDraft(id, "business");
    ctx0.injector().failAt = 3;
    expect(() => approveCandidate(ctx.deps, id, { draft })).toThrow("injected failure");
    ctx0.injector().failAt = null;
    expect(ctx.links()).toHaveLength(0);
    expect(ctx.ledger.state.journals).toHaveLength(0);
    unwrap(approveCandidate(ctx.deps, id, { draft }));
    expect(ctx.activeLinks(id)).toHaveLength(1);
  });
});
