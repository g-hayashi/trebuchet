import { beforeEach, describe, expect, it } from "vitest";
import { closePeriod, getFiscalPeriodHistory, reopenPeriod } from "../src/usecases/close-period.ts";
import { correctJournal } from "../src/usecases/correct-journal.ts";
import { createJournal } from "../src/usecases/create-journal.ts";
import { replaceOpeningBalances } from "../src/usecases/masters.ts";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { setupLedger } from "./ledger-fixture.ts";

let f: ReturnType<typeof setupLedger>;
let masterDeps: { repo: typeof f.masters; ids: typeof f.ids; clock: typeof f.clock };

beforeEach(() => {
  f = setupLedger();
  masterDeps = { repo: f.masters, ids: f.ids, clock: f.clock };
});

const periodAudits = () => f.masters.audits.filter((a) => a.targetType === "fiscal_period");

const close = (year: number) => {
  const r = closePeriod(masterDeps, year);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("closePeriod（US5, FR-024, FR-025）", () => {
  it("締めると status は closed、closed_at に締めた日時が入る", () => {
    f.clock.value = "2027-03-15T10:00:00.000Z";
    const r = closePeriod(masterDeps, 2026);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      ...f.period(2026),
      status: "closed",
      closedAt: "2027-03-15T10:00:00.000Z",
    });
    expect(f.masters.getFiscalPeriodByYear(2026)).toEqual(r.value);
  });

  it("audit_log に close（target_type = fiscal_period、変更前・後の会計期間）が残る", () => {
    const before = f.period(2026);
    const after = close(2026);
    expect(periodAudits()).toHaveLength(1);
    const entry = periodAudits()[0];
    expect(entry).toMatchObject({
      targetType: "fiscal_period",
      targetId: before.id,
      action: "close",
      reason: null,
      occurredAt: f.clock.value,
    });
    expect(JSON.parse(entry?.beforeJson ?? "null")).toEqual(before);
    expect(JSON.parse(entry?.afterJson ?? "null")).toEqual(after);
  });

  it("締め済みの期間を再度締めても状態は変わらず、audit_log も増えない", () => {
    f.clock.value = "2027-03-15T10:00:00.000Z";
    const first = close(2026);
    f.clock.value = "2027-04-01T00:00:00.000Z";
    const again = closePeriod(masterDeps, 2026);
    expect(again).toEqual({ ok: true, value: first });
    expect(f.masters.getFiscalPeriodByYear(2026)).toEqual(first);
    expect(periodAudits()).toHaveLength(1);
  });

  it("ほかの年度の状態は変わらない", () => {
    close(2025);
    expect(f.period(2025).status).toBe("closed");
    expect(f.period(2026)).toMatchObject({ status: "open", closedAt: null });
  });

  it("ない年度は VALIDATION", () => {
    const r = closePeriod(masterDeps, 2030);
    expect(!r.ok && r.error).toMatchObject({ code: "VALIDATION", details: { fiscalYear: 2030 } });
    expect(periodAudits()).toEqual([]);
  });
});

describe("締め済みの期間への変更はすべて PERIOD_CLOSED（INV-7）", () => {
  it("登録できない", () => {
    close(2026);
    const r = createJournal(f.deps, f.sale(1000, "2026-05-01"));
    expect(!r.ok && r.error).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2026, suggest: "correcting_entry" },
    });
    expect(f.ledger.journals).toEqual([]);
  });

  it("訂正できない（元の日付・訂正後の日付のどちらかが締め済みの期間）", () => {
    const in2025 = f.create(f.sale(1000, "2025-06-30"));
    const in2026 = f.create(f.sale(2000, "2026-06-30"));
    close(2025);
    const fromClosed = correctJournal(f.deps, in2025.id, {
      ...f.sale(1500, "2026-01-10"),
      reason: "金額の誤り",
      version: 1,
    });
    expect(!fromClosed.ok && fromClosed.error.code).toBe("PERIOD_CLOSED");
    const intoClosed = correctJournal(f.deps, in2026.id, {
      ...f.sale(2000, "2025-12-31"),
      reason: "日付の誤り",
      version: 1,
    });
    expect(!intoClosed.ok && intoClosed.error.code).toBe("PERIOD_CLOSED");
    expect(f.ledger.getJournal(in2025.id)).toEqual(in2025);
    expect(f.ledger.getJournal(in2026.id)).toEqual(in2026);
  });

  it("取消できない", () => {
    const j = f.create(f.sale(1000, "2026-06-30"));
    close(2026);
    const r = voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 });
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
    expect(f.ledger.getJournal(j.id)).toEqual(j);
  });

  it("期首残高を置き換えられない", () => {
    close(2026);
    const r = replaceOpeningBalances(masterDeps, 2026, [
      { accountId: f.accountId("現金"), side: "debit", amount: 1000 },
      { accountId: f.accountId("元入金"), side: "credit", amount: 1000 },
    ]);
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
    expect(f.masters.listOpeningBalances(f.period(2026).id)).toEqual([]);
  });

  it("締め済みの期間の仕訳への訂正仕訳は、締めていない期間の日付で起票できる", () => {
    const j = f.create(f.sale(1000, "2025-06-30"));
    close(2025);
    const r = createJournal(f.deps, { ...f.sale(100, "2026-02-01"), correctsJournalId: j.id });
    expect(r.ok).toBe(true);
  });
});

describe("reopenPeriod（US5, FR-024, FR-025）", () => {
  it.each(["", "   ", "あ".repeat(501)])(
    "理由が空・空白のみ・500 文字超（%#）なら REASON_REQUIRED で、締め済みのまま",
    (reason) => {
      const closed = close(2026);
      const r = reopenPeriod(masterDeps, 2026, { reason });
      expect(!r.ok && r.error).toMatchObject({
        code: "REASON_REQUIRED",
        details: { field: "reason" },
      });
      expect(f.period(2026)).toEqual(closed);
      expect(periodAudits().map((a) => a.action)).toEqual(["close"]);
    },
  );

  it("理由を付けて解除すると open に戻り、audit_log に reopen と理由が残る", () => {
    const closed = close(2026);
    f.clock.value = "2027-05-01T09:00:00.000Z";
    const r = reopenPeriod(masterDeps, 2026, { reason: " 修正申告のため " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ ...closed, status: "open", closedAt: null });
    expect(f.period(2026)).toEqual(r.value);
    const entry = periodAudits().at(-1);
    expect(entry).toMatchObject({
      targetType: "fiscal_period",
      targetId: closed.id,
      action: "reopen",
      reason: "修正申告のため",
      occurredAt: "2027-05-01T09:00:00.000Z",
    });
    expect(JSON.parse(entry?.beforeJson ?? "null")).toEqual(closed);
    expect(JSON.parse(entry?.afterJson ?? "null")).toEqual(r.value);
  });

  it("解除すると、再び登録・訂正・取消できる", () => {
    const j = f.create(f.sale(1000, "2026-06-30"));
    close(2026);
    expect(reopenPeriod(masterDeps, 2026, { reason: "修正申告" }).ok).toBe(true);
    expect(createJournal(f.deps, f.sale(2000, "2026-07-01")).ok).toBe(true);
    const corrected = correctJournal(f.deps, j.id, {
      ...f.sale(1500, "2026-06-30"),
      reason: "金額の誤り",
      version: 1,
    });
    expect(corrected.ok).toBe(true);
    expect(voidJournal(f.deps, j.id, { reason: "二重登録", version: 2 }).ok).toBe(true);
  });

  it("締めていない期間の解除は状態を変えず、audit_log も増えない", () => {
    const r = reopenPeriod(masterDeps, 2026, { reason: "誤操作" });
    expect(r).toEqual({ ok: true, value: f.period(2026) });
    expect(periodAudits()).toEqual([]);
  });

  it("ない年度は VALIDATION", () => {
    const r = reopenPeriod(masterDeps, 2030, { reason: "修正申告" });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });
});

describe("getFiscalPeriodHistory（FR-025）", () => {
  it("締めと解除の記録を、日時・年度・操作・理由とともに記録の順で返す", () => {
    f.clock.value = "2026-03-15T00:00:00.000Z";
    close(2025);
    f.clock.value = "2027-03-15T00:00:00.000Z";
    close(2026);
    f.clock.value = "2027-05-01T00:00:00.000Z";
    expect(reopenPeriod(masterDeps, 2025, { reason: "修正申告" }).ok).toBe(true);

    expect(getFiscalPeriodHistory(masterDeps)).toEqual([
      { occurredAt: "2026-03-15T00:00:00.000Z", fiscalYear: 2025, action: "close", reason: null },
      { occurredAt: "2027-03-15T00:00:00.000Z", fiscalYear: 2026, action: "close", reason: null },
      {
        occurredAt: "2027-05-01T00:00:00.000Z",
        fiscalYear: 2025,
        action: "reopen",
        reason: "修正申告",
      },
    ]);
  });

  it("締めも解除もしていなければ空", () => {
    expect(getFiscalPeriodHistory(masterDeps)).toEqual([]);
  });
});
