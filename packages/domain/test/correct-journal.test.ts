import { beforeEach, describe, expect, it } from "vitest";
import { correctJournal } from "../src/usecases/correct-journal.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { setupLedger } from "./ledger-fixture.ts";

let f: ReturnType<typeof setupLedger>;

beforeEach(() => {
  f = setupLedger();
});

/** 金額を 500,000 に直す訂正の入力 */
const fix = (version = 1, reason = "金額の誤り") => ({
  ...f.sale(500_000),
  memo: "10月分（訂正）",
  reason,
  version,
});

describe("correctJournal（US3, FR-019, FR-020）", () => {
  it.each(["", "   ", "\n\t"])(
    "理由が空・空白のみ（%j）なら REASON_REQUIRED で何も変えない",
    (reason) => {
      const j = f.create();
      const r = correctJournal(f.deps, j.id, fix(1, reason));
      expect(!r.ok && r.error.code).toBe("REASON_REQUIRED");
      expect(f.ledger.getJournal(j.id)).toEqual(j);
      expect(f.ledger.audits.map((a) => a.action)).toEqual(["create"]);
    },
  );

  it("理由が 500 文字を超えると REASON_REQUIRED", () => {
    const j = f.create();
    expect(correctJournal(f.deps, j.id, fix(1, "あ".repeat(500))).ok).toBe(true);
    const r = correctJournal(f.deps, j.id, fix(2, "あ".repeat(501)));
    expect(!r.ok && r.error.code).toBe("REASON_REQUIRED");
  });

  it("version が一致しなければ VERSION_CONFLICT", () => {
    const j = f.create();
    const r = correctJournal(f.deps, j.id, fix(2));
    expect(!r.ok && r.error).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { journalId: j.id, currentVersion: 1 },
    });
    expect(f.ledger.getJournal(j.id)).toEqual(j);
  });

  it("存在しない仕訳は JOURNAL_NOT_FOUND", () => {
    const missing = "0000000e-0000-7000-8000-000000000001";
    const r = correctJournal(f.deps, missing, fix());
    expect(!r.ok && r.error).toMatchObject({
      code: "JOURNAL_NOT_FOUND",
      details: { journalId: missing },
    });
  });

  it("締め済みの期間の仕訳は PERIOD_CLOSED で、訂正仕訳を案内する", () => {
    const j = f.create(f.sale(1000, "2025-12-20"));
    f.closeYear(2025);
    const r = correctJournal(f.deps, j.id, fix());
    expect(!r.ok && r.error).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2025, suggest: "correcting_entry" },
    });
    expect(f.ledger.getJournal(j.id)).toEqual(j);
  });

  it("新しい日付が締め済みの期間でも PERIOD_CLOSED", () => {
    const j = f.create();
    f.closeYear(2025);
    const r = correctJournal(f.deps, j.id, { ...fix(), date: "2025-12-31" });
    expect(!r.ok && r.error).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2025 },
    });
    expect(f.ledger.getJournal(j.id)).toEqual(j);
  });

  it("訂正後の内容も検証する（貸借の不一致は UNBALANCED で details.errors つき）", () => {
    const j = f.create();
    const r = correctJournal(f.deps, j.id, {
      date: "2026-10-31",
      lines: [f.line("debit", "売掛金", 500_000), f.line("credit", "売上高", 495_000)],
      reason: "金額の誤り",
      version: 1,
    });
    expect(!r.ok && r.error).toMatchObject({
      code: "UNBALANCED",
      details: { diff: 5000, errors: [expect.objectContaining({ code: "UNBALANCED" })] },
    });
    expect(f.ledger.getJournal(j.id)).toEqual(j);
  });

  it("取消済みの仕訳は訂正できない（JOURNAL_VOIDED）", () => {
    const j = f.create();
    const voided = voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 });
    expect(voided.ok).toBe(true);
    const r = correctJournal(f.deps, j.id, fix(2));
    expect(!r.ok && r.error).toMatchObject({
      code: "JOURNAL_VOIDED",
      details: { journalId: j.id },
    });
  });

  it("成功すると内容が置き換わり version が +1 され、仕訳番号・作成日時は変わらない", () => {
    const j = f.create();
    f.clock.value = "2026-11-01T10:00:00.000Z";
    const r = correctJournal(f.deps, j.id, fix());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      id: j.id,
      journalNo: j.journalNo,
      memo: "10月分（訂正）",
      status: "active",
      version: 2,
      createdAt: j.createdAt,
      updatedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(r.value.lines.map((l) => [l.side, l.amount])).toEqual([
      ["debit", 500_000],
      ["credit", 500_000],
    ]);
    expect(f.ledger.getJournal(j.id)).toEqual(r.value);
  });

  it("FR-020: audit_log の correct に、変更前の行・タグを含む全内容と理由・日時が残る", () => {
    const tag = { id: f.ids.next(), name: "定期" };
    f.masters.insertTag(tag);
    const partner = { id: f.ids.next(), name: "A社", honorific: null, memo: null, isActive: true };
    f.masters.insertPartner(partner);
    const j = f.create({
      date: "2026-10-31",
      memo: "10月分",
      lines: [
        { ...f.line("debit", "売掛金", 495_000), partnerId: partner.id, tagIds: [tag.id] },
        { ...f.line("credit", "売上高", 495_000), description: "10月分の売上" },
      ],
    });
    f.clock.value = "2026-11-01T10:00:00.000Z";
    const r = correctJournal(f.deps, j.id, fix(1, "  金額の誤り  "));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const entry = f.ledger.audits.at(-1);
    expect(entry).toMatchObject({
      targetType: "journal",
      targetId: j.id,
      action: "correct",
      reason: "金額の誤り",
      occurredAt: "2026-11-01T10:00:00.000Z",
    });
    const before = JSON.parse(entry?.beforeJson ?? "null");
    expect(before).toEqual(j);
    expect(before.lines[0]).toMatchObject({ partnerId: partner.id, tagIds: [tag.id] });
    expect(before.lines[1]).toMatchObject({ description: "10月分の売上" });
    expect(JSON.parse(entry?.afterJson ?? "null")).toEqual(r.value);
  });

  it("訂正元の仕訳で使っている科目は、使用停止になっていても訂正後に残せる", () => {
    const j = f.create();
    const other = f.create(f.sale(1000));
    const receivable = f.masters.getAccount(f.accountId("売掛金"));
    if (receivable === undefined) throw new Error("科目がない");
    f.masters.updateAccount({ ...receivable, isActive: false });
    expect(correctJournal(f.deps, j.id, fix()).ok).toBe(true);

    const r = correctJournal(f.deps, other.id, {
      ...fix(),
      lines: [f.line("debit", "現金", 1000), f.line("credit", "売上高", 1000)],
    });
    expect(r.ok).toBe(true);
    const back = correctJournal(f.deps, other.id, {
      ...fix(2),
      lines: [f.line("debit", "売掛金", 1000), f.line("credit", "売上高", 1000)],
    });
    expect(!back.ok && back.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("書き込みの途中で例外が起きたら、仕訳も audit_log も変わらない", () => {
    const j = f.create();
    f.ledger.failOnAppendAudit = true;
    expect(() => correctJournal(f.deps, j.id, fix())).toThrow();
    expect(f.ledger.getJournal(j.id)).toEqual(j);
    expect(f.ledger.audits).toHaveLength(1);
  });
});
