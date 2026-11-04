import { fc } from "@trebuchet/domain/testing";
import { ReceiptQuery } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { fakeSha, makeFile, makeLink, makeReceipt, setupReceiptDb } from "./receipt-repo-setup.ts";

// 011 T007: ReceiptStore.count（ホームの「仕訳のない証憑」。R3）。検索と同じ条件で、ページ・並びなしの件数を返す

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("receipt-count");
});
afterEach(() => tmp.cleanup());

describe("ReceiptStore.count", () => {
  it("link=none: 有効な結びつきのない証憑だけ。削除済みは既定で数えず、includeDeleted で数える", () => {
    const s = setupReceiptDb();
    const journal = s.raw.seedJournal();
    s.add({ id: "r1", currentSha256: fakeSha(1) });
    s.add({ id: "r2", currentSha256: fakeSha(2) });
    s.add({
      id: "r3",
      currentSha256: fakeSha(3),
      deletedAt: "2026-10-30T00:00:00.000Z",
      deletedReason: "誤り",
    });
    s.add({ id: "r4", currentSha256: fakeSha(4) });
    s.add({ id: "r5", currentSha256: fakeSha(5) });
    s.inUow((r) => {
      r.insertLink(makeLink("r4", journal));
      // 閉じた結びつきだけの証憑は「仕訳なし」
      const closed = makeLink("r5", journal);
      r.insertLink(closed);
      r.closeLink(closed.id, "2026-10-31T00:00:00.000Z", "解除");
    });
    // r1・r2・r5（閉じた結びつきだけ）。r3 は削除済み、r4 は結びつきあり
    expect(s.inUow((r) => r.count(ReceiptQuery.parse({ link: "none" })))).toBe(3);
    expect(
      s.inUow((r) => r.count(ReceiptQuery.parse({ link: "none", includeDeleted: true }))),
    ).toBe(4);
    expect(s.inUow((r) => r.count(ReceiptQuery.parse({})))).toBe(4);
  });

  it("0 件は 0", () => {
    const s = setupReceiptDb();
    expect(s.inUow((r) => r.count(ReceiptQuery.parse({})))).toBe(0);
  });

  it("件数は検索の全ページの件数と一致する（任意の集合・条件）", () => {
    const specArb = fc.record({
      id: fc.uuid(),
      deleted: fc.boolean(),
      missing: fc.boolean(),
      link: fc.constantFrom("none", "active", "closed"),
    });
    const queryArb = fc.record(
      {
        missing: fc.boolean(),
        link: fc.constantFrom("none" as const, "linked" as const, "journal_voided" as const),
        includeDeleted: fc.boolean(),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(
        fc.uniqueArray(specArb, { selector: (x) => x.id, maxLength: 8 }),
        queryArb,
        (specs, input) => {
          const s = setupReceiptDb();
          const journal = s.raw.seedJournal();
          specs.forEach((spec, i) => {
            const row = makeReceipt({
              id: spec.id,
              currentSha256: fakeSha(i + 1),
              transactionDate: spec.missing ? null : "2026-10-01",
              amount: spec.missing ? null : 1000,
              partnerName: spec.missing ? null : "店",
              ...(spec.deleted
                ? { deletedAt: "2026-10-30T00:00:00.000Z", deletedReason: "誤り" }
                : {}),
            });
            s.inUow((r) => {
              r.insertReceipt(row);
              r.insertFile(makeFile(row.id, { sha256: row.currentSha256 }));
              if (spec.link !== "none") {
                const link = makeLink(row.id, journal);
                r.insertLink(link);
                if (spec.link === "closed")
                  r.closeLink(link.id, "2026-10-31T00:00:00.000Z", "解除");
              }
            });
          });
          const q = ReceiptQuery.parse({ ...input, limit: 200 });
          const found = s.inUow((r) => r.search(q)).rows.length;
          expect(s.inUow((r) => r.count(q))).toBe(found);
        },
      ),
      { numRuns: 25 },
    );
  });
});
