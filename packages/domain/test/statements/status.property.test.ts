import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { statementStatus } from "../../src/statements/status.ts";

// 006 R15・INV-44。明細の状態は、結びつき・除外・仕訳の状態だけで決まる

type J = { id: string; status: "active" | "voided"; correctsJournalId: string | null };

const journal = (id: string, status: J["status"], correctsJournalId: string | null = null): J => ({
  id,
  status,
  correctsJournalId,
});
const link = (journalId: string, revokedAt: string | null = null) => ({ journalId, revokedAt });
const open = { excludedAt: null };
const excluded = { excludedAt: "2026-05-02T00:00:00.000Z" };

describe("statementStatus（例）", () => {
  it("結びつきがなければ unprocessed、除外していれば excluded", () => {
    expect(statementStatus(open, [], [])).toBe("unprocessed");
    expect(statementStatus(excluded, [], [])).toBe("excluded");
  });

  it("有効な結びつきの仕訳が有効なら registered（除外より優先）", () => {
    expect(statementStatus(open, [link("j1")], [journal("j1", "active")])).toBe("registered");
    expect(statementStatus(excluded, [link("j1")], [journal("j1", "active")])).toBe("registered");
  });

  it("仕訳を取り消すと unprocessed に戻る", () => {
    expect(statementStatus(open, [link("j1")], [journal("j1", "voided")])).toBe("unprocessed");
    expect(statementStatus(excluded, [link("j1")], [journal("j1", "voided")])).toBe("excluded");
  });

  it("失効した結びつきは数えない", () => {
    expect(statementStatus(open, [link("j1", "2026-05-03")], [journal("j1", "active")])).toBe(
      "unprocessed",
    );
  });

  it("訂正（corrects）をたどった先に有効な仕訳があれば registered", () => {
    const journals = [
      journal("j1", "voided"),
      journal("j2", "voided", "j1"),
      journal("j3", "active", "j2"),
    ];
    expect(statementStatus(open, [link("j1")], journals)).toBe("registered");
  });

  it("訂正の先がすべて取消済みなら unprocessed", () => {
    const journals = [journal("j1", "voided"), journal("j2", "voided", "j1")];
    expect(statementStatus(open, [link("j1")], journals)).toBe("unprocessed");
  });
});

describe("statementStatus（INV-44）", () => {
  const chainArb = fc.array(fc.constantFrom<J["status"]>("active", "voided"), {
    minLength: 1,
    maxLength: 5,
  });

  /** 結びつけた仕訳 j0 から、訂正の連鎖 j0 ← j1 ← j2 ... を作る */
  const buildChain = (statuses: J["status"][]): J[] =>
    statuses.map((s, i) => journal(`j${i}`, s, i === 0 ? null : `j${i - 1}`));

  it("状態は、有効な結びつき・除外・連鎖の有効な仕訳の有無だけで決まる", () => {
    fc.assert(
      fc.property(chainArb, fc.boolean(), fc.boolean(), (statuses, isExcluded, revoked) => {
        const journals = buildChain(statuses);
        const links = [link("j0", revoked ? "2026-05-03" : null)];
        const statement = isExcluded ? excluded : open;
        const anyActive = statuses.includes("active");
        const expected =
          !revoked && anyActive ? "registered" : isExcluded ? "excluded" : "unprocessed";
        expect(statementStatus(statement, links, journals)).toBe(expected);
      }),
    );
  });

  it("仕訳の並びに依らない", () => {
    fc.assert(
      fc.property(
        chainArb.chain((s) =>
          fc.tuple(fc.constant(s), fc.shuffledSubarray(buildChain(s), { minLength: s.length })),
        ),
        ([statuses, shuffled]) => {
          expect(statementStatus(open, [link("j0")], shuffled)).toBe(
            statementStatus(open, [link("j0")], buildChain(statuses)),
          );
        },
      ),
    );
  });
});
