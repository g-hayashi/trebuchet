import { beforeEach, describe, expect, it } from "vitest";
import { createEntity } from "../src/usecases/create-entity.ts";
import { type MasterDeps, setAccountReportLine } from "../src/usecases/masters.ts";
import {
  FixedClock,
  InMemoryClosingStore,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";

let repo: InMemoryMasterRepository;
let closing: InMemoryClosingStore;
let deps: MasterDeps & { closing: InMemoryClosingStore };

beforeEach(() => {
  repo = new InMemoryMasterRepository();
  closing = new InMemoryClosingStore(new InMemoryLedgerRepository());
  const ids = new SequentialIds();
  const clock = new FixedClock("2026-10-18T00:00:00.000Z");
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => repo, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  deps = { repo, closing, ids, clock };
});

const account = (name: string) => {
  const a = repo.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a;
};

describe("setAccountReportLine（R12a、FR-006）", () => {
  it("費用の科目の欄を変更し、closing_audit_log に前後の欄番号を残す", () => {
    const supplies = account("消耗品費");
    const before = supplies.reportLine;
    const r = setAccountReportLine(deps, supplies.id, 31);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.reportLine).toBe(31);
    expect(repo.getAccount(supplies.id)?.reportLine).toBe(31);
    expect(closing.audits).toHaveLength(1);
    expect(closing.audits[0]).toMatchObject({
      targetType: "account_report_line",
      targetId: supplies.id,
      action: "update",
      occurredAt: "2026-10-18T00:00:00.000Z",
    });
    expect(JSON.parse(closing.audits[0]?.beforeJson ?? "null")).toEqual({ reportLine: before });
    expect(JSON.parse(closing.audits[0]?.afterJson ?? "null")).toEqual({ reportLine: 31 });
  });

  it("null で解除でき、欄 8 と 31 の両端も許す", () => {
    const supplies = account("消耗品費");
    for (const line of [null, 8, 31, 25]) {
      const r = setAccountReportLine(deps, supplies.id, line);
      expect(r.ok).toBe(true);
      expect(repo.getAccount(supplies.id)?.reportLine).toBe(line);
    }
  });

  it("値が変わらなければ履歴を残さない", () => {
    const supplies = account("消耗品費");
    const r = setAccountReportLine(deps, supplies.id, supplies.reportLine);
    expect(r.ok).toBe(true);
    expect(closing.audits).toHaveLength(0);
  });

  it("費用以外の科目は REPORT_LINE_INVALID（変更も履歴もなし）", () => {
    for (const name of ["現金", "売上高", "未払金", "元入金"]) {
      const a = account(name);
      const r = setAccountReportLine(deps, a.id, 17);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("REPORT_LINE_INVALID");
      expect(repo.getAccount(a.id)?.reportLine).toBe(a.reportLine);
    }
    expect(closing.audits).toHaveLength(0);
  });

  it("欄 32 や 7、0、小数は REPORT_LINE_INVALID", () => {
    const supplies = account("消耗品費");
    for (const line of [32, 7, 1, 0, -1, 45, 10.5]) {
      const r = setAccountReportLine(deps, supplies.id, line);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("REPORT_LINE_INVALID");
    }
    expect(closing.audits).toHaveLength(0);
  });

  it("科目がなければ ACCOUNT_NOT_FOUND", () => {
    const r = setAccountReportLine(deps, "no-such-account", 17);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
