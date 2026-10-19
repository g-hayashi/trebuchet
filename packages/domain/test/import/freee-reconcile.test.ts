import { describe, expect, it } from "vitest";
import {
  type FreeeLedgerAccount,
  parseFreeeLedger,
  readFreeeFile,
} from "../../src/import/freee/read.ts";
import { type ReconcileInput, reconcile } from "../../src/import/freee/reconcile.ts";
import type { Balance } from "../../src/reports/balances.ts";
import {
  EXPECTED_BOOK_ACCOUNTS,
  EXPECTED_JOURNAL,
  FIXTURE_FILES,
} from "../fixtures/freee/expected.ts";
import { readFixture } from "../fixtures/freee/load.ts";
import {
  ACCOUNTS,
  accountId,
  fixtureJournals,
  PERIOD_2025,
  ref,
  withInactive,
} from "./import-setup.ts";

function fixtureLedger(): FreeeLedgerAccount[] {
  const file = readFreeeFile(readFixture(FIXTURE_FILES.ledger));
  if (!file.ok) throw new Error(JSON.stringify(file.error));
  const parsed = parseFreeeLedger(file.value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

const byCode = new Map(ACCOUNTS.map((a) => [a.code, a]));
const normalSign = (code: string) => (byCode.get(code)?.normalSide === "debit" ? 1 : -1);

/** EXPECTED_BOOK_ACCOUNTS（通常の側を正）を computeBalances の形（借方を正）にした帳簿の残高 */
function fixtureBalances(): Balance[] {
  return Object.entries(EXPECTED_BOOK_ACCOUNTS).map(([code, e]) => ({
    accountId: accountId(code),
    subAccountId: null,
    opening: normalSign(code) * e.opening + 0,
    debit: e.debit,
    credit: e.credit,
    closing: normalSign(code) * e.closing + 0,
  }));
}

/** 取込対象外の決算振替を除く、フィクスチャの仕訳の取り消されていない参照 */
function fixtureRefs() {
  return fixtureJournals()
    .journals.filter(
      (j) =>
        !(EXPECTED_JOURNAL.priorYearClosingIds as readonly string[]).includes(j.freeeJournalId),
    )
    .map((j) =>
      ref(j.freeeJournalId, {
        freeeJournalNo: j.freeeJournalNo,
        freeeDate: j.date,
        journalId: `journal-${j.freeeJournalId}`,
      }),
    );
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    fiscalYear: 2025,
    ledger: fixtureLedger(),
    savedMappings: [],
    accounts: ACCOUNTS,
    subAccounts: [],
    periods: [PERIOD_2025],
    balances: fixtureBalances(),
    refs: fixtureRefs(),
    ...overrides,
  };
}

function run(overrides: Partial<ReconcileInput> = {}) {
  const r = reconcile(input(overrides));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** 帳簿の残高から、ある科目の借方・貸方を減らす（その仕訳を取り込まなかった状態） */
function withoutMovement(
  balances: Balance[],
  code: string,
  movement: { debit: number; credit: number },
): Balance[] {
  return balances.map((b) =>
    b.accountId === accountId(code)
      ? {
          ...b,
          debit: b.debit - movement.debit,
          credit: b.credit - movement.credit,
          closing: b.closing - movement.debit + movement.credit,
        }
      : b,
  );
}

/** 2025-09-01 事業主貸 50,000 / その他口座（freee の仕訳番号 5090101） */
const DRAWINGS_ID = "900000132";
const DRAWINGS_NO = "5090101";
function withoutDrawings(): Balance[] {
  return withoutMovement(
    withoutMovement(fixtureBalances(), "3090", { debit: 50_000, credit: 0 }),
    "1020",
    { debit: 0, credit: 50_000 },
  );
}

describe("reconcile（T047, research R7）", () => {
  it("元帳の側: 期首は開始行 ＋ 期首日付の決算振替、借方・貸方は振替を除く、期末は最後の行の残高", () => {
    const result = run();
    const freee = Object.fromEntries(
      result.rows.map((r) => [byCode.get(r.accountCode)?.code ?? r.accountCode, r.freee]),
    );
    expect(freee).toEqual(EXPECTED_BOOK_ACCOUNTS);
    expect(result.allMatched).toBe(true);
    expect(result.unmapped).toEqual([]);
    for (const row of result.rows) {
      expect(row.matched).toBe(true);
      expect(row.difference).toEqual({ opening: 0, debit: 0, credit: 0, closing: 0 });
      expect(row.candidates).toEqual([]);
      expect(row.book).toEqual(row.freee);
    }
  });

  it("行は帳簿の科目の順（sortOrder → コード）で、科目のコード・名前を持つ", () => {
    const result = run();
    const codes = result.rows.map((r) => r.accountCode);
    const expected = ACCOUNTS.filter((a) => a.code in EXPECTED_BOOK_ACCOUNTS)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
      .map((a) => a.code);
    expect(codes).toEqual(expected);
    const capital = result.rows.find((r) => r.accountCode === "3020");
    expect(capital).toMatchObject({ accountId: accountId("3020"), accountName: "元入金" });
  });

  it("freee の2つの科目（事務用品費と消耗品費）を帳簿の1つの科目にまとめた場合は合計で比べる", () => {
    const row = run().rows.find((r) => r.accountCode === "5170");
    expect(row?.sourceNames).toEqual(["消耗品費", "事務用品費"]);
    expect(row?.freee).toEqual({ opening: 0, debit: 9_900, credit: 0, closing: 9_900 });
    expect(row?.matched).toBe(true);
  });

  it("「損益」は比べない（行にも unmapped にも出ない）", () => {
    const result = run();
    expect(result.rows.flatMap((r) => r.sourceNames)).not.toContain("損益");
    expect(result.unmapped).not.toContain("損益");
  });

  it("カードの科目は未払金にまとめ、帳簿の補助科目は合算して比べる", () => {
    const balances = fixtureBalances().flatMap((b) =>
      b.accountId === accountId("2020")
        ? [
            { ...b, subAccountId: "sub-abc", opening: -10_000, closing: -7_060 },
            {
              accountId: b.accountId,
              subAccountId: null,
              opening: -5_000,
              debit: 0,
              credit: 0,
              closing: -5_000,
            },
          ]
        : [b],
    );
    const row = run({ balances }).rows.find((r) => r.accountCode === "2020");
    expect(row?.sourceNames).toEqual(["ABCカード"]);
    expect(row?.book).toEqual({ opening: 15_000, debit: 15_000, credit: 12_060, closing: 12_060 });
    expect(row?.matched).toBe(true);
  });

  it("保存済みの対応表に従う（カードを別の科目に対応させると、その科目と比べる）", () => {
    const result = run({
      savedMappings: [{ sourceName: "ABCカード", accountId: accountId("2030") }],
    });
    expect(result.rows.find((r) => r.accountCode === "2030")?.freee).toEqual({
      opening: 15_000,
      debit: 15_000,
      credit: 12_060,
      closing: 12_060,
    });
    // 帳簿は未払金に入っているので、両方の科目が不一致になる
    expect(result.rows.find((r) => r.accountCode === "2030")?.matched).toBe(false);
    expect(result.rows.find((r) => r.accountCode === "2020")?.freee).toEqual({
      opening: 0,
      debit: 0,
      credit: 0,
      closing: 0,
    });
    expect(result.allMatched).toBe(false);
  });

  it("対応が未定の科目は unmapped に入れて比べない。allMatched は false", () => {
    const result = run({ accounts: withInactive(["4020"]) });
    expect(result.unmapped).toEqual(["雑収入"]);
    expect(result.rows.flatMap((r) => r.sourceNames)).not.toContain("雑収入");
    expect(result.allMatched).toBe(false);
  });

  it("帳簿にだけ残高がある科目も行に出す（元帳の側は 0）", () => {
    const balances: Balance[] = [
      ...fixtureBalances(),
      {
        accountId: accountId("5110"),
        subAccountId: null,
        opening: 0,
        debit: 1_000,
        credit: 0,
        closing: 1_000,
      },
    ];
    const row = run({ balances }).rows.find((r) => r.accountCode === "5110");
    expect(row).toMatchObject({
      sourceNames: [],
      freee: { opening: 0, debit: 0, credit: 0, closing: 0 },
      book: { opening: 0, debit: 1_000, credit: 0, closing: 1_000 },
      difference: { opening: 0, debit: 1_000, credit: 0, closing: 1_000 },
      matched: false,
      candidates: [],
    });
  });

  it("1仕訳を取り込まなかった: その科目だけが不一致になり、差額と原因の候補（NOT_IMPORTED）が出る", () => {
    const refs = fixtureRefs().filter((r) => r.freeeJournalId !== DRAWINGS_ID);
    const result = run({ balances: withoutDrawings(), refs });
    expect(result.allMatched).toBe(false);
    expect(result.rows.filter((r) => !r.matched).map((r) => r.accountCode)).toEqual([
      "1020",
      "3090",
    ]);
    const drawings = result.rows.find((r) => r.accountCode === "3090");
    expect(drawings?.difference).toEqual({
      opening: 0,
      debit: -50_000,
      credit: 0,
      closing: -50_000,
    });
    expect(drawings?.candidates).toEqual([
      {
        date: "2025-09-01",
        freeeJournalNo: DRAWINGS_NO,
        debit: 50_000,
        credit: 0,
        cause: "NOT_IMPORTED",
      },
    ]);
    const bank = result.rows.find((r) => r.accountCode === "1020");
    expect(bank?.difference).toEqual({ opening: 0, debit: 0, credit: -50_000, closing: 50_000 });
    expect(bank?.candidates).toEqual([
      {
        date: "2025-09-01",
        freeeJournalNo: DRAWINGS_NO,
        debit: 0,
        credit: 50_000,
        cause: "NOT_IMPORTED",
      },
    ]);
  });

  it("取り消した取込の仕訳（参照が取消済み）は VOIDED_IMPORT", () => {
    const refs = fixtureRefs().map((r) =>
      r.freeeJournalId === DRAWINGS_ID ? { ...r, revokedAt: "2026-10-01T00:00:00.000Z" } : r,
    );
    const result = run({ balances: withoutDrawings(), refs });
    const drawings = result.rows.find((r) => r.accountCode === "3090");
    expect(drawings?.candidates.map((c) => c.cause)).toEqual(["VOIDED_IMPORT"]);
  });

  it("取込の判定を渡すと、取込対象外・取込不可を理由つきで分ける", () => {
    const refs = fixtureRefs().filter((r) => r.freeeJournalId !== DRAWINGS_ID);
    const excluded = run({
      balances: withoutDrawings(),
      refs,
      decisions: [{ freeeJournalNo: DRAWINGS_NO, decision: "excluded", reason: "USER_EXCLUDED" }],
    });
    expect(excluded.rows.find((r) => r.accountCode === "3090")?.candidates).toEqual([
      {
        date: "2025-09-01",
        freeeJournalNo: DRAWINGS_NO,
        debit: 50_000,
        credit: 0,
        cause: "EXCLUDED",
        reason: "USER_EXCLUDED",
      },
    ]);
    const rejected = run({
      balances: withoutDrawings(),
      refs,
      decisions: [{ freeeJournalNo: DRAWINGS_NO, decision: "rejected", reason: "UNMAPPED" }],
    });
    expect(rejected.rows.find((r) => r.accountCode === "3090")?.candidates[0]).toMatchObject({
      cause: "REJECTED",
      reason: "UNMAPPED",
    });
  });

  it("期首日付の決算振替の行は原因の候補にしない（期首に繰り込み済み）", () => {
    // 元入金の期首をずらして不一致にしても、振替の行（5010101）は候補に出ない
    const balances = fixtureBalances().map((b) =>
      b.accountId === accountId("3020")
        ? { ...b, opening: b.opening - 1, closing: b.closing - 1 }
        : b,
    );
    const row = run({ balances }).rows.find((r) => r.accountCode === "3020");
    expect(row?.matched).toBe(false);
    expect(row?.difference.opening).toBe(1);
    expect(row?.candidates).toEqual([]);
  });

  it("会計期間がない年度 → OUT_OF_PERIOD、元帳の取引日が会計期間の外 → VALIDATION", () => {
    const noPeriod = reconcile(input({ fiscalYear: 2024 }));
    expect(noPeriod.ok ? undefined : noPeriod.error.code).toBe("OUT_OF_PERIOD");

    const ledger = fixtureLedger().map((a, i) =>
      i === 0
        ? {
            ...a,
            rows: [
              ...a.rows,
              { ...(a.rows[0] as FreeeLedgerAccount["rows"][number]), date: "2026-01-05" },
            ],
          }
        : a,
    );
    const outside = reconcile(input({ ledger }));
    expect(outside.ok ? undefined : outside.error).toMatchObject({
      code: "VALIDATION",
      details: { fiscalYear: 2025, ledgerDate: "2026-01-05" },
    });
  });
});
