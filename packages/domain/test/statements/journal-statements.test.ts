import { beforeEach, describe, expect, it } from "vitest";
import { createJournal } from "../../src/usecases/create-journal.ts";
import { approveCandidate, unlinkStatement } from "../../src/usecases/statement-approval.ts";
import { buildCandidates, listJournalStatements } from "../../src/usecases/statements.ts";
import { unwrap } from "../result.ts";
import { type StatementsCtx, setupStatements } from "../statements-setup.ts";

// 006 T016（FR-020）: 仕訳から元の明細へ。001 の `GET /journals/:journalId` の `statements`

let ctx: StatementsCtx;
beforeEach(() => {
  ctx = setupStatements();
  ctx.mapBank();
});

describe("listJournalStatements", () => {
  it("承認で作った仕訳には、明細の ID と created を返す。結びつきのない仕訳は空", () => {
    ctx.importRows([ctx.row({ content: "文房具", amount: -1_200 })]);
    const id = ctx.idOf("文房具");
    const r = unwrap(
      approveCandidate(ctx.deps, id, { draft: ctx.shapeDraft(id, "business", ctx.a.supplies) }),
    );
    expect(unwrap(listJournalStatements(ctx.deps, r.journal?.id as string))).toEqual([
      { statementId: id, kind: "created" },
    ]);
    expect(unwrap(listJournalStatements(ctx.deps, "00000000-0000-7000-8000-00000000ffff"))).toEqual(
      [],
    );
  });

  it("既存の仕訳への結びつき（matched）を返し、外した（失効した）ら出さない", () => {
    const existing = unwrap(
      createJournal(ctx.ledgerDeps, {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: ctx.a.rent, amount: 80_000 },
          { side: "credit", accountId: ctx.a.bank, amount: 80_000 },
        ],
      }),
    ).journal;
    ctx.importRows([ctx.row({ content: "家賃", amount: -80_000 })]);
    const id = ctx.idOf("家賃");
    unwrap(buildCandidates(ctx.deps));
    unwrap(approveCandidate(ctx.deps, id));
    expect(unwrap(listJournalStatements(ctx.deps, existing.id))).toEqual([
      { statementId: id, kind: "matched" },
    ]);
    unwrap(unlinkStatement(ctx.deps, id, { reason: "別の取引だった" }));
    expect(unwrap(listJournalStatements(ctx.deps, existing.id))).toEqual([]);
  });
});
