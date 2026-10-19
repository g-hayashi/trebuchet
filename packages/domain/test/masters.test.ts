import { beforeEach, describe, expect, it } from "vitest";
import { createEntity } from "../src/usecases/create-entity.ts";
import type { MasterDeps } from "../src/usecases/masters.ts";
import {
  addAccount,
  addSubAccount,
  addTag,
  createNextFiscalPeriod,
  deleteAccount,
  renameAccount,
  replaceOpeningBalances,
  replaceTaxSettings,
  setAccountActive,
  upsertPartner,
} from "../src/usecases/masters.ts";
import { FixedClock, InMemoryMasterRepository, InMemoryRegistry, SequentialIds } from "./fakes.ts";

let repo: InMemoryMasterRepository;
let deps: MasterDeps;
let entityId: string;

beforeEach(() => {
  repo = new InMemoryMasterRepository();
  const ids = new SequentialIds();
  const clock = new FixedClock("2026-10-18T00:00:00.000Z");
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => repo, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  entityId = created.value.id;
  deps = { repo, ids, clock };
});

const account = (name: string) => {
  const a = repo.listAccounts().find((x) => x.name === name);
  if (a === undefined) throw new Error(`科目がない: ${name}`);
  return a;
};

const expectError = (result: { ok: boolean; error?: { code: string } }, code: string) => {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe(code);
};

describe("勘定科目（FR-005）", () => {
  it("仕訳で使われた科目の削除は ACCOUNT_IN_USE で拒否する", () => {
    const cash = account("現金");
    repo.usedAccountIds.add(cash.id);
    expectError(deleteAccount(deps, cash.id), "ACCOUNT_IN_USE");
    expect(repo.getAccount(cash.id)).toBeDefined();
  });

  it("期首残高で使われた科目の削除も ACCOUNT_IN_USE で拒否する", () => {
    const cash = account("現金");
    const capital = account("元入金");
    const r = replaceOpeningBalances(deps, 2026, [
      { accountId: cash.id, side: "debit", amount: 1000 },
      { accountId: capital.id, side: "credit", amount: 1000 },
    ]);
    expect(r.ok).toBe(true);
    expectError(deleteAccount(deps, cash.id), "ACCOUNT_IN_USE");
  });

  it("使われていない科目は削除でき、補助科目もあわせて消える", () => {
    const meeting = account("会議費");
    expect(addSubAccount(deps, meeting.id, "社内").ok).toBe(true);
    expect(deleteAccount(deps, meeting.id).ok).toBe(true);
    expect(repo.getAccount(meeting.id)).toBeUndefined();
    expect(repo.listSubAccounts(meeting.id)).toEqual([]);
  });

  it("存在しない科目の操作は ACCOUNT_NOT_FOUND", () => {
    const missing = "00000000-0000-7000-8000-ffffffffffff";
    expectError(deleteAccount(deps, missing), "ACCOUNT_NOT_FOUND");
    expectError(renameAccount(deps, missing, "x"), "ACCOUNT_NOT_FOUND");
    expectError(setAccountActive(deps, missing, false), "ACCOUNT_NOT_FOUND");
    expectError(addSubAccount(deps, missing, "x"), "ACCOUNT_NOT_FOUND");
  });

  it("使用中の科目でも使用停止にでき、audit_log に deactivate を残す", () => {
    const cash = account("現金");
    repo.usedAccountIds.add(cash.id);
    const result = setAccountActive(deps, cash.id, false);
    expect(result.ok).toBe(true);
    expect(repo.getAccount(cash.id)?.isActive).toBe(false);
    const audit = repo.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "account",
      targetId: cash.id,
      action: "deactivate",
      reason: null,
      occurredAt: "2026-10-18T00:00:00.000Z",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ isActive: true });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ isActive: false });
  });

  it("使用停止を解除できる", () => {
    const cash = account("現金");
    setAccountActive(deps, cash.id, false);
    expect(setAccountActive(deps, cash.id, true).ok).toBe(true);
    expect(repo.getAccount(cash.id)?.isActive).toBe(true);
  });

  it("状態が変わらない使用停止は audit_log に残さない", () => {
    const cash = account("現金");
    const before = repo.audits.length;
    expect(setAccountActive(deps, cash.id, true).ok).toBe(true);
    expect(repo.audits).toHaveLength(before);
  });

  it("科目名の変更は audit_log に rename（変更前・後の名前）を残す", () => {
    const fee = account("支払手数料");
    const result = renameAccount(deps, fee.id, "  支払い手数料 ");
    expect(result.ok).toBe(true);
    expect(repo.getAccount(fee.id)?.name).toBe("支払い手数料");
    expect(repo.getAccount(fee.id)?.code).toBe(fee.code);
    const audit = repo.audits.at(-1);
    expect(audit).toMatchObject({ targetType: "account", targetId: fee.id, action: "rename" });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual({ name: "支払手数料" });
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({ name: "支払い手数料" });
  });

  it("ほかの科目と同じ名前・空の名前への変更は VALIDATION", () => {
    const fee = account("支払手数料");
    expectError(renameAccount(deps, fee.id, "会議費"), "VALIDATION");
    expectError(renameAccount(deps, fee.id, "   "), "VALIDATION");
    expect(repo.audits).toHaveLength(0);
  });

  it("利用者が追加した科目のコードは区分ごとに自動採番される", () => {
    const a = addAccount(deps, {
      name: "セミナー費",
      category: "expense",
      reportSection: "PL_EXPENSE",
      reportLine: 30,
    });
    const b = addAccount(deps, {
      name: "サブスク費",
      category: "expense",
      reportSection: "PL_EXPENSE",
    });
    const c = addAccount(deps, { name: "定期預金", category: "asset", reportSection: "BS_ASSET" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("addAccount failed");
    const codes = repo.listAccounts().map((x) => x.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Number(b.value.code)).toBe(Number(a.value.code) + 1);
    expect(a.value.code[0]).toBe(account("雑費").code[0]);
    expect(c.value.code[0]).toBe(account("現金").code[0]);
    expect(a.value).toMatchObject({
      category: "expense",
      normalSide: "debit",
      reportLine: 30,
      isSystem: false,
      isActive: true,
    });
    expect(b.value.reportLine).toBeNull();
  });

  it("追加した科目は決算書の欄の位置に並ぶ（欄30は雑費の前、欄なしは区分の末尾）", () => {
    addAccount(deps, {
      name: "セミナー費",
      category: "expense",
      reportSection: "PL_EXPENSE",
      reportLine: 30,
    });
    addAccount(deps, { name: "サブスク費", category: "expense", reportSection: "PL_EXPENSE" });
    addAccount(deps, { name: "定期預金", category: "asset", reportSection: "BS_ASSET" });
    const names = repo.listAccounts().map((a) => a.name);
    expect(names.indexOf("セミナー費")).toBe(names.indexOf("雑費") - 1);
    expect(names.indexOf("サブスク費")).toBe(names.indexOf("雑費") + 1);
    expect(names.indexOf("定期預金")).toBeLessThan(names.indexOf("未払金"));
  });

  it("追加する科目の名前の重複・区分と決算書の区分の不整合は VALIDATION", () => {
    expectError(
      addAccount(deps, { name: "現金", category: "asset", reportSection: "BS_ASSET" }),
      "VALIDATION",
    );
    expectError(
      addAccount(deps, { name: "謎の資産", category: "asset", reportSection: "PL_EXPENSE" }),
      "VALIDATION",
    );
  });
});

describe("補助科目（FR-006）", () => {
  it("同じ科目内で名前が重複しない（別の科目なら同じ名前を使える）", () => {
    const bank = account("普通預金");
    const payable = account("未払金");
    const first = addSubAccount(deps, bank.id, "A銀行");
    expect(first.ok).toBe(true);
    expect(first.ok && first.value).toMatchObject({ accountId: bank.id, isActive: true });
    expectError(addSubAccount(deps, bank.id, " A銀行 "), "VALIDATION");
    expect(addSubAccount(deps, payable.id, "A銀行").ok).toBe(true);
    expect(repo.listSubAccounts(bank.id)).toHaveLength(1);
  });
});

describe("取引先・メモタグ（FR-007, FR-008）", () => {
  it("取引先を登録・編集でき、名前の重複は VALIDATION", () => {
    const created = upsertPartner(deps, { name: "株式会社A", honorific: "御中" });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value).toMatchObject({ honorific: "御中", memo: null, isActive: true });
    const updated = upsertPartner(
      deps,
      { name: "株式会社A", honorific: null, memo: "契約中" },
      created.value.id,
    );
    expect(updated.ok && updated.value).toMatchObject({
      id: created.value.id,
      honorific: null,
      memo: "契約中",
    });
    expect(repo.listPartners()).toHaveLength(1);
    expectError(upsertPartner(deps, { name: "株式会社A", honorific: null }), "VALIDATION");
    expectError(
      upsertPartner(deps, { name: "B", honorific: null }, "00000000-0000-7000-8000-ffffffffffff"),
      "VALIDATION",
    );
  });

  it("メモタグの名前は重複しない", () => {
    expect(addTag(deps, "出張").ok).toBe(true);
    expectError(addTag(deps, "出張"), "VALIDATION");
    expect(repo.listTags()).toHaveLength(1);
  });
});

describe("消費税の設定（FR-009）", () => {
  it("検証して一括置換し、audit_log に replace（変更前・後）を残す", () => {
    const before = repo.listTaxSettings();
    const result = replaceTaxSettings(deps, [
      { effectiveFrom: "2027-01-01", taxpayerStatus: "general", accountingMethod: "tax_included" },
      { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
    ]);
    expect(result.ok).toBe(true);
    expect(repo.listTaxSettings().map((s) => s.effectiveFrom)).toEqual([
      "2026-01-01",
      "2027-01-01",
    ]);
    const audit = repo.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "tax_setting",
      targetId: entityId,
      action: "replace",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual(before);
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual(repo.listTaxSettings());
  });

  it("重複・最初の会計期間に空白があれば TAX_SETTING_GAP で、何も変えない", () => {
    const before = repo.listTaxSettings();
    expectError(
      replaceTaxSettings(deps, [
        { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
        {
          effectiveFrom: "2026-01-01",
          taxpayerStatus: "general",
          accountingMethod: "tax_included",
        },
      ]),
      "TAX_SETTING_GAP",
    );
    expectError(
      replaceTaxSettings(deps, [
        { effectiveFrom: "2026-02-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
      ]),
      "TAX_SETTING_GAP",
    );
    expect(repo.listTaxSettings()).toEqual(before);
    expect(repo.audits).toHaveLength(0);
  });
});

describe("会計期間（FR-012）", () => {
  it("最後の期間の翌日から1年の期間を作る", () => {
    const next = createNextFiscalPeriod(deps);
    expect(next.ok && next.value).toMatchObject({
      fiscalYear: 2027,
      startDate: "2027-01-01",
      endDate: "2027-12-31",
      status: "open",
      closedAt: null,
    });
    const after = createNextFiscalPeriod(deps);
    expect(after.ok && after.value).toMatchObject({ fiscalYear: 2028, endDate: "2028-12-31" });
    expect(repo.listFiscalPeriods().map((p) => p.fiscalYear)).toEqual([2026, 2027, 2028]);
  });
});

describe("期首残高（FR-011）", () => {
  it("検証して一括置換し、audit_log に replace を残す", () => {
    const cash = account("現金");
    const bank = account("普通預金");
    const capital = account("元入金");
    const sub = addSubAccount(deps, bank.id, "A銀行");
    if (!sub.ok) throw new Error(sub.error.message);
    const result = replaceOpeningBalances(deps, 2026, [
      { accountId: cash.id, side: "debit", amount: 100_000 },
      { accountId: bank.id, subAccountId: sub.value.id, side: "debit", amount: 200_000 },
      { accountId: capital.id, side: "credit", amount: 300_000 },
    ]);
    expect(result.ok).toBe(true);
    const period = repo.getFiscalPeriodByYear(2026);
    if (period === undefined) throw new Error("period");
    const saved = repo.listOpeningBalances(period.id);
    expect(saved).toHaveLength(3);
    expect(saved.find((o) => o.accountId === bank.id)?.subAccountId).toBe(sub.value.id);
    expect(saved.find((o) => o.accountId === cash.id)?.subAccountId).toBeNull();
    const audit = repo.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "opening_balance",
      targetId: period.id,
      action: "replace",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual([]);
    expect(JSON.parse(audit?.afterJson ?? "null")).toHaveLength(3);

    // 置き換え
    expect(
      replaceOpeningBalances(deps, 2026, [
        { accountId: cash.id, side: "debit", amount: 5 },
        { accountId: capital.id, side: "credit", amount: 5 },
      ]).ok,
    ).toBe(true);
    expect(repo.listOpeningBalances(period.id)).toHaveLength(2);
  });

  it("貸借が合わなければ UNBALANCED で、何も書き込まない", () => {
    const result = replaceOpeningBalances(deps, 2026, [
      { accountId: account("現金").id, side: "debit", amount: 500_000 },
      { accountId: account("元入金").id, side: "credit", amount: 495_000 },
    ]);
    expectError(result, "UNBALANCED");
    expect(!result.ok && result.error.details).toEqual({
      debit: 500_000,
      credit: 495_000,
      diff: 5_000,
    });
    expect(repo.audits).toHaveLength(0);
  });

  it("締め済みの期間は PERIOD_CLOSED", () => {
    const period = repo.getFiscalPeriodByYear(2026);
    if (period === undefined) throw new Error("period");
    repo.updateFiscalPeriod({ ...period, status: "closed", closedAt: "2027-03-01T00:00:00.000Z" });
    expectError(
      replaceOpeningBalances(deps, 2026, [
        { accountId: account("現金").id, side: "debit", amount: 1 },
        { accountId: account("元入金").id, side: "credit", amount: 1 },
      ]),
      "PERIOD_CLOSED",
    );
  });

  it("存在しない年度は VALIDATION、存在しない科目は ACCOUNT_NOT_FOUND、別の科目の補助科目は VALIDATION", () => {
    const rows = (accountId: string, subAccountId?: string) => [
      { accountId, subAccountId, side: "debit" as const, amount: 1 },
      { accountId: account("元入金").id, side: "credit" as const, amount: 1 },
    ];
    expectError(replaceOpeningBalances(deps, 2030, rows(account("現金").id)), "VALIDATION");
    expectError(
      replaceOpeningBalances(deps, 2026, rows("00000000-0000-7000-8000-ffffffffffff")),
      "ACCOUNT_NOT_FOUND",
    );
    const sub = addSubAccount(deps, account("普通預金").id, "A銀行");
    if (!sub.ok) throw new Error(sub.error.message);
    expectError(
      replaceOpeningBalances(deps, 2026, rows(account("現金").id, sub.value.id)),
      "VALIDATION",
    );
    expect(repo.audits).toHaveLength(0);
  });
});
