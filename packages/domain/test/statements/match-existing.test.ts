import { describe, expect, it } from "vitest";
import {
  MATCH_WINDOW_DAYS,
  matchConfidence,
  matchExistingJournal,
} from "../../src/statements/match-existing.ts";
import type { Journal, JournalLine } from "../../src/types.ts";

// 006 T013（R7、FR-021a）。既存の仕訳との照合

const BANK = "acc-bank";
const RENT = "acc-rent";

const line = (id: string, over: Partial<JournalLine> = {}): JournalLine => ({
  id,
  lineNo: 1,
  side: "credit",
  accountId: BANK,
  subAccountId: null,
  amount: 80_000,
  taxCategory: "OUT_OF_SCOPE",
  taxAmount: 0,
  partnerId: null,
  description: null,
  tagIds: [],
  ...over,
});

/** 借 家賃 / 貸 普通預金（定期仕訳の家賃） */
const rent = (
  id: string,
  over: Partial<Journal> = {},
  bankOver: Partial<JournalLine> = {},
): Journal => ({
  id,
  journalNo: 1,
  date: "2026-05-10",
  fiscalPeriodId: "fp",
  memo: "家賃",
  status: "active",
  correctsJournalId: null,
  source: "recurring",
  version: 1,
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
  lines: [
    line(`${id}-d`, { lineNo: 1, side: "debit", accountId: RENT }),
    line(`${id}-c`, { lineNo: 2, ...bankOver }),
  ],
  ...over,
});

const statement = (over: Partial<{ date: string; amount: number }> = {}) => ({
  date: "2026-05-10",
  amount: -80_000,
  ...over,
});
const account = { accountId: BANK, subAccountId: null };
const none = new Set<string>();

describe("matchExistingJournal", () => {
  it("定期仕訳の家賃（貸方の普通預金・同額）に、同じ日の出金が一致する。行の ID を返す", () => {
    const m = matchExistingJournal(statement(), account, [rent("j1")], none);
    expect(m).toMatchObject({ journalId: "j1", lineId: "j1-c", daysDiff: 0 });
    expect(m?.confidence).toBe(matchConfidence(0));
  });

  it("入金は借方の行に一致する（出金は貸方）", () => {
    const j = rent("j2", {}, { side: "debit" });
    expect(matchExistingJournal(statement({ amount: 80_000 }), account, [j], none)?.lineId).toBe(
      "j2-c",
    );
    // 向きが違えば一致しない
    expect(matchExistingJournal(statement({ amount: 80_000 }), account, [rent("j1")], none)).toBe(
      undefined,
    );
  });

  it(`日付の差は ${MATCH_WINDOW_DAYS} 日まで（境目）`, () => {
    const j = rent("j1");
    expect(
      matchExistingJournal(statement({ date: "2026-05-17" }), account, [j], none),
    ).toBeDefined();
    expect(
      matchExistingJournal(statement({ date: "2026-05-03" }), account, [j], none),
    ).toBeDefined();
    expect(
      matchExistingJournal(statement({ date: "2026-05-18" }), account, [j], none),
    ).toBeUndefined();
    expect(
      matchExistingJournal(statement({ date: "2026-05-02" }), account, [j], none),
    ).toBeUndefined();
  });

  it("差が大きいほど確信度が下がる", () => {
    const at = (date: string) =>
      matchExistingJournal(statement({ date }), account, [rent("j1")], none)?.confidence ?? -1;
    expect(at("2026-05-10")).toBeGreaterThan(at("2026-05-12"));
    expect(at("2026-05-12")).toBeGreaterThan(at("2026-05-17"));
    expect(matchConfidence(0)).toBeLessThanOrEqual(100);
    expect(matchConfidence(MATCH_WINDOW_DAYS)).toBeGreaterThanOrEqual(0);
  });

  it("金額・科目・補助科目が違えば一致しない（補助科目は同じであること）", () => {
    expect(
      matchExistingJournal(statement({ amount: -80_001 }), account, [rent("j1")], none),
    ).toBeUndefined();
    expect(
      matchExistingJournal(
        statement(),
        { accountId: "acc-other", subAccountId: null },
        [rent("j1")],
        none,
      ),
    ).toBeUndefined();
    expect(
      matchExistingJournal(
        statement(),
        { accountId: BANK, subAccountId: "sub-1" },
        [rent("j1")],
        none,
      ),
    ).toBeUndefined();
    expect(
      matchExistingJournal(
        statement(),
        { accountId: BANK, subAccountId: "sub-1" },
        [rent("j1", {}, { subAccountId: "sub-1" })],
        none,
      )?.lineId,
    ).toBe("j1-c");
  });

  it("取消済みの仕訳は対象外", () => {
    expect(
      matchExistingJournal(statement(), account, [rent("j1", { status: "voided" })], none),
    ).toBeUndefined();
  });

  it("すでに明細に結びついた行は対象外（ほかの候補があればそちら）", () => {
    const journals = [rent("j1"), rent("j2", { date: "2026-05-12", journalNo: 2 })];
    expect(matchExistingJournal(statement(), account, journals, new Set(["j1-c"]))?.journalId).toBe(
      "j2",
    );
    expect(
      matchExistingJournal(statement(), account, [rent("j1")], new Set(["j1-c"])),
    ).toBeUndefined();
  });

  it("候補が複数なら日付の差が最も小さい行（同じなら仕訳番号の小さい方）", () => {
    const journals = [
      rent("far", { date: "2026-05-15", journalNo: 1 }),
      rent("near", { date: "2026-05-11", journalNo: 3 }),
      rent("tie", { date: "2026-05-09", journalNo: 2 }),
    ];
    expect(matchExistingJournal(statement(), account, journals, none)?.journalId).toBe("tie");
    expect(matchExistingJournal(statement(), account, journals.slice(0, 2), none)?.journalId).toBe(
      "near",
    );
  });

  it("科目のない口座（private）・0 円は一致しない", () => {
    expect(
      matchExistingJournal(
        statement(),
        { accountId: null, subAccountId: null },
        [rent("j1")],
        none,
      ),
    ).toBeUndefined();
    expect(
      matchExistingJournal(statement({ amount: 0 }), account, [rent("j1")], none),
    ).toBeUndefined();
  });
});
