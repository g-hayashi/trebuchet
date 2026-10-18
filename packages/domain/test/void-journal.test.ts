import { beforeEach, describe, expect, it } from "vitest";
import { voidJournal } from "../src/usecases/void-journal.ts";
import { setupLedger } from "./ledger-fixture.ts";

let f: ReturnType<typeof setupLedger>;

beforeEach(() => {
  f = setupLedger();
});

describe("voidJournal（US3, FR-019, FR-021）", () => {
  it.each(["", "  "])("理由が空・空白のみ（%j）なら REASON_REQUIRED", (reason) => {
    const j = f.create();
    const r = voidJournal(f.deps, j.id, { reason, version: 1 });
    expect(!r.ok && r.error.code).toBe("REASON_REQUIRED");
    expect(f.ledger.getJournal(j.id)?.status).toBe("active");
  });

  it("取消後の status は voided、version は +1。行は残る", () => {
    const j = f.create();
    f.clock.value = "2026-11-02T08:00:00.000Z";
    const r = voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      ...j,
      status: "voided",
      version: 2,
      updatedAt: "2026-11-02T08:00:00.000Z",
    });
    expect(f.ledger.getJournal(j.id)).toEqual(r.value);
  });

  it("audit_log に void と変更前の内容・理由が残る", () => {
    const j = f.create();
    const r = voidJournal(f.deps, j.id, { reason: " 二重登録 ", version: 1 });
    expect(r.ok).toBe(true);
    const entry = f.ledger.audits.at(-1);
    expect(entry).toMatchObject({
      targetType: "journal",
      targetId: j.id,
      action: "void",
      reason: "二重登録",
    });
    expect(JSON.parse(entry?.beforeJson ?? "null")).toEqual(j);
    expect(JSON.parse(entry?.afterJson ?? "null")).toMatchObject({ status: "voided", version: 2 });
  });

  it("締め済みの期間なら PERIOD_CLOSED で、訂正仕訳を案内する", () => {
    const j = f.create(f.sale(1000, "2025-06-30"));
    f.closeYear(2025);
    const r = voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 });
    expect(!r.ok && r.error).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYear: 2025, suggest: "correcting_entry" },
    });
    expect(f.ledger.getJournal(j.id)?.status).toBe("active");
  });

  it("version の不一致は VERSION_CONFLICT、取消済みの取消は JOURNAL_VOIDED、ない仕訳は JOURNAL_NOT_FOUND", () => {
    const j = f.create();
    const stale = voidJournal(f.deps, j.id, { reason: "二重登録", version: 3 });
    expect(!stale.ok && stale.error.code).toBe("VERSION_CONFLICT");
    expect(voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 }).ok).toBe(true);
    const again = voidJournal(f.deps, j.id, { reason: "二重登録", version: 2 });
    expect(!again.ok && again.error.code).toBe("JOURNAL_VOIDED");
    const missing = voidJournal(f.deps, "0000000e-0000-7000-8000-000000000001", {
      reason: "x",
      version: 1,
    });
    expect(!missing.ok && missing.error.code).toBe("JOURNAL_NOT_FOUND");
    expect(f.ledger.audits.map((a) => a.action)).toEqual(["create", "void"]);
  });

  it("書き込みの途中で例外が起きたら、仕訳も audit_log も変わらない", () => {
    const j = f.create();
    f.ledger.failOnAppendAudit = true;
    expect(() => voidJournal(f.deps, j.id, { reason: "二重登録", version: 1 })).toThrow();
    expect(f.ledger.getJournal(j.id)).toEqual(j);
    expect(f.ledger.audits).toHaveLength(1);
  });
});
