import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JournalSource } from "../src/types.ts";
import { correctJournal } from "../src/usecases/correct-journal.ts";
import { createJournal } from "../src/usecases/create-journal.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { setupLedger } from "./ledger-fixture.ts";

const SOURCES: JournalSource[] = ["manual", "import_freee", "invoice", "payment", "recurring"];
const LINKED: JournalSource[] = ["invoice", "payment"];
const isLinked = (s: JournalSource) => LINKED.includes(s);

type Op = "correct" | "void" | "corrected_by_entry";
const OPS: Op[] = ["correct", "void", "corrected_by_entry"];

/** 仕訳を source つきで登録し、操作を実行して結果を返す */
function run(
  source: JournalSource,
  op: Op,
  options: { linked?: boolean },
  entrySource: JournalSource = "manual",
) {
  const f = setupLedger();
  const created = createJournal(f.deps, f.sale(1000, "2025-06-30"), { source });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const j = created.value.journal;
  switch (op) {
    case "correct":
      return {
        j,
        result: correctJournal(
          f.deps,
          j.id,
          { ...f.sale(2000, "2025-06-30"), reason: "訂正", version: 1 },
          options,
        ),
      };
    case "void":
      return {
        j,
        result: voidJournal(f.deps, j.id, { reason: "取消", version: 1 }, options),
      };
    case "corrected_by_entry": {
      // 訂正元にするには締め済みの年度の仕訳でなければならない
      f.closeYear(2025);
      return {
        j,
        result: createJournal(
          f.deps,
          { ...f.sale(2000, "2026-01-10"), correctsJournalId: j.id },
          { source: entrySource },
        ),
      };
    }
  }
}

describe("INV-39: invoice・payment の仕訳は linked なしでは訂正・取消・訂正元にできない", () => {
  it("linked なしなら invoice・payment の仕訳の操作は必ず JOURNAL_LINKED（details.journalId だけ）。それ以外の source は従来どおり", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SOURCES), fc.constantFrom(...OPS), (source, op) => {
        const { j, result } = run(source, op, {});
        if (isLinked(source)) {
          expect(!result.ok && result.error.code).toBe("JOURNAL_LINKED");
          expect(!result.ok && result.error.details).toEqual({ journalId: j.id });
        } else {
          expect(result.ok).toBe(true);
        }
      }),
    );
  });

  it("linked ありなら invoice・payment の仕訳の訂正・取消が通る", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINKED),
        fc.constantFrom<Op>("correct", "void"),
        (source, op) => {
          const { result } = run(source, op, { linked: true });
          expect(result.ok).toBe(true);
        },
      ),
    );
  });

  it("訂正仕訳の起票は、訂正元と同じ source のときだけ invoice・payment の仕訳を訂正元にできる", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINKED),
        fc.constantFrom(...SOURCES),
        (source, entrySource) => {
          const { j, result } = run(source, "corrected_by_entry", {}, entrySource);
          if (entrySource === source) {
            expect(result.ok).toBe(true);
          } else {
            expect(!result.ok && result.error.code).toBe("JOURNAL_LINKED");
            expect(!result.ok && result.error.details).toEqual({ journalId: j.id });
          }
        },
      ),
    );
  });

  it("recurring の仕訳は通常どおり訂正・取消できる（FR-026）", () => {
    for (const op of OPS) {
      expect(run("recurring", op, {}).result.ok).toBe(true);
    }
  });

  it("JOURNAL_LINKED で失敗したときは何も書き込まない", () => {
    const f = setupLedger();
    const created = createJournal(f.deps, f.sale(), { source: "invoice" });
    if (!created.ok) throw new Error("create");
    const j = created.value.journal;
    const r = voidJournal(f.deps, j.id, { reason: "取消", version: 1 });
    expect(!r.ok && r.error.code).toBe("JOURNAL_LINKED");
    expect(f.ledger.getJournal(j.id)).toEqual(j);
    expect(f.ledger.audits.map((a) => a.action)).toEqual(["create"]);
  });
});
