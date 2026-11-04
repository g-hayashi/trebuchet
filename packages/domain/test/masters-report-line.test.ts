import { beforeEach, describe, expect, it } from "vitest";
import { createEntity } from "../src/usecases/create-entity.ts";
import {
  addAccount,
  type MasterDeps,
  setAccountReportLine,
  updateAccount,
} from "../src/usecases/masters.ts";
import {
  FixedClock,
  fakeClosingUnitOfWork,
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

/** 利用者が足した費用の科目（最初からある科目は名前を変えられない。FR-047） */
const userExpense = (name: string) => {
  const r = addAccount(deps, { name, category: "expense", reportSection: "PL_EXPENSE" });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
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

describe("updateAccount（PATCH /accounts/:accountId）", () => {
  const uowDeps = () => ({
    uow: fakeClosingUnitOfWork(new InMemoryLedgerRepository(), repo, closing),
    ids: deps.ids,
    clock: deps.clock,
  });

  it("名称・使用停止・欄を 1 回で変え、audit_log と closing_audit_log に残す", () => {
    const supplies = userExpense("備品消耗品");
    const r = updateAccount(uowDeps(), supplies.id, {
      name: "事務用品費",
      isActive: false,
      reportLine: 31,
    });
    expect(r.ok).toBe(true);
    expect(repo.getAccount(supplies.id)).toMatchObject({
      name: "事務用品費",
      isActive: false,
      reportLine: 31,
    });
    expect(repo.audits.map((a) => a.action).slice(-2)).toEqual(["rename", "deactivate"]);
    expect(closing.audits).toHaveLength(1);
  });

  it("後の項目が失敗すると、先に変えた名称・使用停止も記録も残らない", () => {
    const supplies = userExpense("備品消耗品");
    const masters = structuredClone(repo.state);
    const r = updateAccount(uowDeps(), supplies.id, {
      name: "事務用品費",
      isActive: false,
      reportLine: 99,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REPORT_LINE_INVALID");
    expect(repo.state).toEqual(masters);
    expect(closing.audits).toHaveLength(0);
  });

  it("科目がなければ ACCOUNT_NOT_FOUND", () => {
    const r = updateAccount(uowDeps(), "no-such-account", { name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});
