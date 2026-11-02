import {
  linkStateOf,
  matchesReceiptQuery,
  normalizeReceiptText,
  type ReceiptRow,
} from "@trebuchet/domain";
import { fc } from "@trebuchet/domain/testing";
import { ReceiptQuery, type ReceiptQueryInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { fakeSha, makeFile, makeLink, makeReceipt, setupReceiptDb } from "./receipt-repo-setup.ts";

// INV-65（検索）: 小さな集合で、SQL の検索 = 素朴なフィルタ（matchesReceiptQuery）で、並びは received_at DESC, id DESC。
// ページを続けて引くと全体と同じ。1 回ごとに新しい DB を作るので実行回数を絞る

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("receipt-search");
});
afterEach(() => tmp.cleanup());

const DATES = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-11-01"] as const;
const AMOUNTS = [1, 100, 1100, 50000] as const;
// 全角・半角・大文字小文字・空白・LIKE の記号
const PARTNERS = ["ＡＢＣ　カフェ", "abc cafe", "100%果汁", "a_b", "x\\y", "ｶﾌｪ", "店"] as const;
const TERMS = [
  "abc",
  "ＡＢＣ",
  "ｶﾌｪ",
  "カフェ",
  "%",
  "_",
  "\\",
  "a_b",
  "果汁",
  "zz",
  " 店 ",
] as const;
const RECEIVED = [
  "2026-10-01T00:00:00.000Z",
  "2026-10-01T00:00:01.000Z",
  "2026-10-02T09:30:00.000Z",
] as const;

const orNull = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null });

const specArb = fc.record({
  id: fc.uuid(),
  receivedAt: fc.constantFrom(...RECEIVED),
  category: fc.constantFrom("paper_scan" as const, "electronic" as const),
  transactionDate: orNull(fc.constantFrom(...DATES)),
  amount: orNull(fc.constantFrom(...AMOUNTS)),
  partnerName: orNull(fc.constantFrom(...PARTNERS)),
  deleted: fc.boolean(),
  // none: なし / active: 有効な仕訳 / voided: 取り消された仕訳 / closed: 閉じた結びつきだけ
  link: fc.constantFrom("none", "active", "voided", "closed"),
});

const setArb = fc.uniqueArray(specArb, { selector: (x) => x.id, maxLength: 8 });

const queryArb: fc.Arbitrary<ReceiptQueryInput> = fc.record(
  {
    dateFrom: fc.constantFrom(...DATES),
    dateTo: fc.constantFrom(...DATES),
    amountMin: fc.constantFrom(...AMOUNTS),
    amountMax: fc.constantFrom(...AMOUNTS),
    partner: fc.constantFrom(...TERMS),
    category: fc.constantFrom("paper_scan" as const, "electronic" as const),
    missing: fc.boolean(),
    link: fc.constantFrom("none" as const, "linked" as const, "journal_voided" as const),
    includeDeleted: fc.boolean(),
    limit: fc.integer({ min: 1, max: 4 }),
  },
  { requiredKeys: [] },
);

describe("INV-65（検索）", () => {
  it("SQL の検索の結果 = 素朴なフィルタの結果（並び・ページ送りを含む）", () => {
    fc.assert(
      fc.property(setArb, fc.array(queryArb, { minLength: 1, maxLength: 4 }), (specs, queries) => {
        const s = setupReceiptDb();
        const active = s.raw.seedJournal();
        const voided = s.raw.seedJournal();
        s.raw.run("UPDATE journals SET status = 'voided' WHERE id = ?", voided);
        const statusOf = new Map([
          [active, "active" as const],
          [voided, "voided" as const],
        ]);

        const rows: ReceiptRow[] = [];
        const linkOf = new Map<string, { journalId: string } | undefined>();
        specs.forEach((spec, i) => {
          const row = makeReceipt({
            id: spec.id,
            receivedAt: spec.receivedAt,
            category: spec.category,
            currentSha256: fakeSha(i + 1),
            transactionDate: spec.transactionDate,
            amount: spec.amount,
            partnerName: spec.partnerName,
            ...(spec.deleted ? { deletedAt: spec.receivedAt, deletedReason: "誤り" } : {}),
          });
          rows.push(row);
          s.inUow((r) => {
            r.insertReceipt(row);
            r.insertFile(makeFile(row.id, { sha256: row.currentSha256 }));
            if (spec.link === "active" || spec.link === "voided" || spec.link === "closed") {
              const journalId = spec.link === "voided" ? voided : active;
              const link = makeLink(row.id, journalId);
              r.insertLink(link);
              if (spec.link === "closed") r.closeLink(link.id, spec.receivedAt, "解除");
            }
          });
          linkOf.set(
            row.id,
            spec.link === "none" || spec.link === "closed"
              ? undefined
              : { journalId: spec.link === "voided" ? voided : active },
          );
        });

        const sorted = [...rows].sort((a, b) => {
          const x = `${a.receivedAt}|${a.id}`;
          const y = `${b.receivedAt}|${b.id}`;
          return x < y ? 1 : x > y ? -1 : 0;
        });

        for (const input of queries) {
          const q = ReceiptQuery.parse(input);
          const expected = sorted
            .filter((r) => {
              const link = linkOf.get(r.id);
              const state = linkStateOf(
                link === undefined ? undefined : makeLink(r.id, link.journalId),
                link === undefined ? undefined : statusOf.get(link.journalId),
              );
              return matchesReceiptQuery(r, state, q);
            })
            .map((r) => r.id);

          // 全部のページを続けて引く
          const got: string[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < 20; guard += 1) {
            const page = s.inUow((r) =>
              r.search(ReceiptQuery.parse({ ...input, ...(cursor ? { cursor } : {}) })),
            );
            expect(page.rows.length).toBeLessThanOrEqual(q.limit);
            got.push(...page.rows.map((x) => x.receipt.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
          }
          expect(got).toEqual(expected);
        }
      }),
      { numRuns: 25 },
    );
  });

  it("全角・半角・大文字小文字・空白の違いだけの取引先は同じ結果になる", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TERMS), (term) => {
        const s = setupReceiptDb();
        s.add({
          partnerName: "ＡＢＣ　カフェ",
          partnerKey: normalizeReceiptText("ＡＢＣ　カフェ"),
        });
        const variants = [term, term.toLowerCase(), term.normalize("NFKC"), ` ${term} `];
        const results = variants.map(
          (partner) => s.inUow((r) => r.search(ReceiptQuery.parse({ partner }))).rows.length,
        );
        expect(new Set(results).size).toBe(1);
      }),
      { numRuns: 11 },
    );
  });
});
