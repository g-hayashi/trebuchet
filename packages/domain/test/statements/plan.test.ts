import { describe, expect, it } from "vitest";
import { type ExistingStatement, planStatementImport } from "../../src/statements/plan.ts";
import type { StatementRow } from "../../src/statements/table.ts";
import { accountsFor } from "../statements-arbitraries.ts";

// 006 R3・R14（FR-004〜006）。取込の計画: 新規・取込済み・変更あり・重複の疑い・未対応の口座

const row = (over: Partial<StatementRow> = {}): StatementRow => ({
  accountName: "サンプル銀行",
  date: "2026-05-10",
  content: "ショップ001",
  amount: -1200,
  transferFlag: false,
  ...over,
});

const existingOf = (r: StatementRow, key: string, over: Partial<ExistingStatement> = {}) => ({
  id: `id-${key}`,
  stableKey: key,
  externalId: null,
  accountName: r.accountName,
  date: r.date,
  amount: r.amount,
  content: r.content,
  categoryMajor: r.categoryMajor ?? null,
  categoryMinor: r.categoryMinor ?? null,
  memo: r.memo ?? null,
  ...over,
});

const accounts = accountsFor(["サンプル銀行", "テストカードA"]);

describe("planStatementImport", () => {
  it("既存がなければすべて new。キーは口座名|日付|金額|正規化した内容|n", () => {
    const plan = planStatementImport([row(), row({ amount: -300 })], [], accounts);
    expect(plan.rows.map((r) => [r.status, r.key])).toEqual([
      ["new", "サンプル銀行|2026-05-10|-1200|ショップ#|0"],
      ["new", "サンプル銀行|2026-05-10|-300|ショップ#|0"],
    ]);
    expect(plan.countNew).toBe(2);
    expect(plan.countExisting).toBe(0);
    expect(plan.countChanged).toBe(0);
  });

  it("キーが同じ明細は existing（新規 0 件）", () => {
    const r = row();
    const plan = planStatementImport(
      [r],
      [existingOf(r, "サンプル銀行|2026-05-10|-1200|ショップ#|0")],
      accounts,
    );
    expect(plan.rows[0]?.status).toBe("existing");
    expect(plan.countNew).toBe(0);
    expect(plan.countExisting).toBe(1);
  });

  it("同じ組の行は出現の順で見る: 1 件が取込済みで 2 件を貼り付けると 1 件だけ新規", () => {
    const r = row();
    const plan = planStatementImport(
      [r, r],
      [existingOf(r, "サンプル銀行|2026-05-10|-1200|ショップ#|0")],
      accounts,
    );
    expect(plan.rows.map((x) => x.status)).toEqual(["existing", "new"]);
  });

  describe("変更あり（external_id が同じで内容が違う）", () => {
    const before = row({ externalId: "ext-1", memo: "古いメモ" });
    const stored = existingOf(before, "サンプル銀行|2026-05-10|-1200|ショップ#|0", {
      externalId: "ext-1",
    });

    it("内容が違えば changed。変更前後を持つ", () => {
      const after = row({ externalId: "ext-1", amount: -1500, memo: "新しいメモ" });
      const plan = planStatementImport([after], [stored], accounts);
      const planned = plan.rows[0];
      expect(planned?.status).toBe("changed");
      expect(planned?.existingId).toBe(stored.id);
      expect(planned?.changed?.before).toMatchObject({ amount: -1200, memo: "古いメモ" });
      expect(planned?.changed?.after).toMatchObject({ amount: -1500, memo: "新しいメモ" });
      expect(plan.countChanged).toBe(1);
      expect(plan.countNew).toBe(0);
    });

    it("内容が同じなら existing", () => {
      const plan = planStatementImport([before], [stored], accounts);
      expect(plan.rows[0]?.status).toBe("existing");
    });

    it("external_id が既存のどれとも違えば new", () => {
      const plan = planStatementImport(
        [row({ externalId: "ext-9", amount: -9 })],
        [stored],
        accounts,
      );
      expect(plan.rows[0]?.status).toBe("new");
    });
  });

  describe("重複の疑い（POSSIBLE_DUPLICATE）", () => {
    const stored = (over: Partial<ExistingStatement> = {}) =>
      existingOf(row(), "サンプル銀行|2026-05-10|-1200|ショップ#|0", over);
    const warningsOf = (r: StatementRow, existing: ExistingStatement[]) =>
      planStatementImport([r], existing, accounts).rows[0]?.warnings;

    it("口座・金額・内容が同じで日付が 3 日以内", () => {
      expect(warningsOf(row({ date: "2026-05-13" }), [stored()])).toEqual(["POSSIBLE_DUPLICATE"]);
      expect(warningsOf(row({ date: "2026-05-07" }), [stored()])).toEqual(["POSSIBLE_DUPLICATE"]);
    });

    it("4 日以上離れていれば疑わない", () => {
      expect(warningsOf(row({ date: "2026-05-14" }), [stored()])).toEqual([]);
    });

    it("口座・日付・内容が同じで金額が違う", () => {
      expect(warningsOf(row({ amount: -1250 }), [stored()])).toEqual(["POSSIBLE_DUPLICATE"]);
    });

    it("口座が違えば疑わない。内容の違い（正規化後）も疑わない", () => {
      const r = row({ date: "2026-05-11", accountName: "テストカードA" });
      expect(warningsOf(r, [stored()])).toEqual([]);
      expect(warningsOf(row({ date: "2026-05-11", content: "別の店" }), [stored()])).toEqual([]);
    });

    it("数字の違いだけの内容は同じとみなす（正規化）", () => {
      expect(warningsOf(row({ date: "2026-05-11", content: "ショップ 002" }), [stored()])).toEqual([
        "POSSIBLE_DUPLICATE",
      ]);
    });

    it("existing・changed の行には付けない", () => {
      const r = row();
      const plan = planStatementImport(
        [r],
        [stored(), stored({ stableKey: "x", date: "2026-05-11" })],
        accounts,
      );
      expect(plan.rows[0]?.status).toBe("existing");
      expect(plan.rows[0]?.warnings).toEqual([]);
    });
  });

  it("未対応の口座の名前を、重複なく名前順で返す", () => {
    const plan = planStatementImport(
      [
        row({ accountName: "ゆ口座" }),
        row({ accountName: "あ口座" }),
        row({ accountName: "ゆ口座", amount: -5 }),
        row(),
      ],
      [],
      accounts,
    );
    expect(plan.unmappedAccounts).toEqual(["あ口座", "ゆ口座"]);
  });

  it("入出金の合計（入金・出金の絶対値）と期間", () => {
    const plan = planStatementImport(
      [
        row({ date: "2026-05-12", amount: 5000 }),
        row({ date: "2026-05-03", amount: -1200 }),
        row({ date: "2026-05-20", amount: -300 }),
      ],
      [],
      accounts,
    );
    expect(plan.totals).toEqual({ inflow: 5000, outflow: 1500 });
    expect(plan.period).toEqual({ from: "2026-05-03", to: "2026-05-20" });
  });

  it("行がなければ期間は null", () => {
    expect(planStatementImport([], [], accounts).period).toBeNull();
  });
});
