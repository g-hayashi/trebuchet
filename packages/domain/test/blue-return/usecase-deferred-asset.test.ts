import { beforeEach, describe, expect, it } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import {
  commitAdjustment,
  getAdjustmentProposals,
  getBlueReturn,
} from "../../src/usecases/blue-return.ts";
import {
  decideDeferredAmortization,
  listDeferredAssets,
  saveDeferredAsset,
} from "../../src/usecases/deferred-assets.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { type FakeClosingUnitOfWork, fakeClosingUnitOfWork } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";
import { codeOf, unwrap } from "../result.ts";

let fx: ReturnType<typeof setupLedger>;
let uow: FakeClosingUnitOfWork;

beforeEach(() => {
  fx = setupLedger();
  uow = fakeClosingUnitOfWork(fx.ledger, fx.masters);
  uow.closing.taxParameters = [...TAX_PARAMETERS];
});

const reports = () => new InMemoryReportRepository(fx.ledger, fx.masters);
const settingsDeps = () => ({
  uow,
  masters: fx.masters,
  closing: uow.closing,
  ids: fx.ids,
  clock: fx.clock,
});
const readDeps = () => ({ masters: fx.masters, closing: uow.closing, reports: reports() });
const commitDeps = () => ({ uow, reports: reports(), ids: fx.ids, clock: fx.clock });

const input = (over: Record<string, unknown> = {}) => ({
  name: "開業準備費",
  totalAmount: 600_000,
  openedOn: "2025-04-10",
  priorAccumulated: 0,
  accountId: fx.accountId("開業費"),
  ...over,
});

const save = (over: Record<string, unknown> = {}) => saveDeferredAsset(settingsDeps(), input(over));
const decide = (deferredAssetId: string, fiscalYear: number, amount: number) =>
  decideDeferredAmortization(settingsDeps(), { deferredAssetId, fiscalYear, amount });
const snapshot = () =>
  structuredClone({
    ledger: fx.ledger.state,
    closing: uow.closing.state,
    masters: fx.masters.state,
  });

/** 決定して案を確定し、償却の仕訳を登録する */
const registerYear = (id: string, fiscalYear: number, amount: number) => {
  unwrap(decide(id, fiscalYear, amount));
  return unwrap(
    commitAdjustment(commitDeps(), {
      fiscalYear,
      kind: "deferred_amortization",
      sourceId: id,
      expected: { amount },
    }),
  );
};

describe("saveDeferredAsset（FR-012、R5）", () => {
  it("登録すると ID と日時を付け、closing_audit_log に deferred_asset（create）を残す", () => {
    const asset = unwrap(save({ note: "開業前の広告費" }));
    expect(asset).toMatchObject({
      name: "開業準備費",
      totalAmount: 600_000,
      openedOn: "2025-04-10",
      priorAccumulated: 0,
      priorThroughYear: null,
      note: "開業前の広告費",
      createdAt: "2026-10-31T09:00:00.000Z",
    });
    expect(uow.closing.listDeferredAssets()).toEqual([asset]);
    const [audit, ...rest] = uow.closing.audits;
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({
      targetType: "deferred_asset",
      targetId: asset.id,
      action: "create",
      beforeJson: null,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ id: asset.id });
  });

  it("id を付けると更新する。作成日時はそのまま、理由と変更前・後を残す", () => {
    const created = unwrap(save());
    const updated = unwrap(
      saveDeferredAsset(settingsDeps(), {
        ...input({ totalAmount: 700_000 }),
        id: created.id,
        reason: "請求書の追加",
      }),
    );
    expect(updated).toMatchObject({
      id: created.id,
      totalAmount: 700_000,
      createdAt: created.createdAt,
    });
    expect(uow.closing.listDeferredAssets()).toHaveLength(1);
    const audit = uow.closing.audits[1];
    expect(audit).toMatchObject({
      targetType: "deferred_asset",
      targetId: created.id,
      action: "update",
      reason: "請求書の追加",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ totalAmount: 600_000 });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ totalAmount: 700_000 });
  });

  it("存在しない id の更新は VALIDATION", () => {
    const r = saveDeferredAsset(settingsDeps(), { ...input(), id: "missing" });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });

  it("検査に落ちれば何も書かない（勘定の区分・累計・総額・開業日）", () => {
    const before = snapshot();
    expect(codeOf(save({ accountId: fx.accountId("減価償却費") }))).toBe("ASSET_ACCOUNT_INVALID");
    expect(codeOf(save({ priorAccumulated: 700_000, priorThroughYear: 2025 }))).toBe(
      "PRIOR_ACCUMULATED_INVALID",
    );
    expect(codeOf(save({ priorAccumulated: 1 }))).toBe("PRIOR_ACCUMULATED_INVALID");
    expect(codeOf(save({ totalAmount: 0 }))).toBe("VALIDATION");
    expect(codeOf(save({ openedOn: "2025-02-30" }))).toBe("VALIDATION");
    expect(snapshot()).toEqual(before);
  });

  it("開業日に適用される月数の税制の値がなければ TAX_PARAMETER_MISSING（何も書かない）", () => {
    uow.closing.taxParameters = [];
    const before = snapshot();
    const r = save();
    expect(!r.ok && r.error.code).toBe("TAX_PARAMETER_MISSING");
    expect(!r.ok && r.error.details).toMatchObject({
      key: "OPENING_COST_AMORTIZATION_MONTHS",
      date: "2025-04-10",
    });
    expect(snapshot()).toEqual(before);
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED", () => {
    const profile = fx.masters.getProfile();
    if (profile === undefined) throw new Error("事業体がない");
    fx.masters.saveProfile({ ...profile, kind: "corporation" });
    expect(codeOf(save())).toBe("ENTITY_KIND_UNSUPPORTED");
    expect(codeOf(listDeferredAssets(readDeps(), {}))).toBe("ENTITY_KIND_UNSUPPORTED");
  });
});

describe("saveDeferredAsset の更新の制限（R12）", () => {
  it("有効な償却の仕訳がなければ計算に効く項目も更新できる（決定だけでは制限しない）", () => {
    const asset = unwrap(save());
    unwrap(decide(asset.id, 2025, 90_000));
    const r = saveDeferredAsset(settingsDeps(), {
      ...input({ totalAmount: 700_000 }),
      id: asset.id,
    });
    expect(r.ok).toBe(true);
  });

  it("有効な仕訳があれば、総額・開業日・累計とその年・勘定の変更は 409（details.years）", () => {
    const asset = unwrap(save());
    registerYear(asset.id, 2025, 90_000);
    const before = snapshot();
    const change = (over: Record<string, unknown>) =>
      saveDeferredAsset(settingsDeps(), { ...input(over), id: asset.id, reason: "変更" });
    for (const over of [
      { totalAmount: 700_000 },
      { openedOn: "2025-05-10" },
      { priorAccumulated: 10_000, priorThroughYear: 2025 },
      { accountId: fx.accountId("普通預金") },
    ]) {
      const r = change(over);
      expect(!r.ok && r.error.code, JSON.stringify(over)).toBe("DEPRECIATION_JOURNAL_EXISTS");
      expect(!r.ok && r.error.details?.years).toEqual([2025]);
    }
    expect(snapshot()).toEqual(before);
  });

  it("名称・備考だけの変更は有効な仕訳があっても通る", () => {
    const asset = unwrap(save());
    registerYear(asset.id, 2025, 90_000);
    const r = unwrap(
      saveDeferredAsset(settingsDeps(), {
        ...input({ name: "開業準備費（改）", note: "備考を足した" }),
        id: asset.id,
        reason: "名称の修正",
      }),
    );
    expect(r).toMatchObject({
      name: "開業準備費（改）",
      note: "備考を足した",
      totalAmount: 600_000,
    });
    expect(uow.closing.audits.at(-1)).toMatchObject({
      targetType: "deferred_asset",
      action: "update",
      reason: "名称の修正",
    });
  });

  it("仕訳を取り消した後は更新できる", () => {
    const asset = unwrap(save());
    const { journal } = registerYear(asset.id, 2025, 90_000);
    const change = () =>
      saveDeferredAsset(settingsDeps(), { ...input({ totalAmount: 700_000 }), id: asset.id });
    expect(codeOf(change())).toBe("DEPRECIATION_JOURNAL_EXISTS");
    unwrap(voidJournal(fx.deps, journal.id, { reason: "やり直し", version: journal.version }));
    expect(codeOf(change())).toBe("ok");
  });
});

describe("listDeferredAssets", () => {
  it("year を付けなければ amortization は null、付ければその年度の上限・目安・決定を付ける", () => {
    const asset = unwrap(save());
    const none = unwrap(listDeferredAssets(readDeps(), {}));
    expect(none).toEqual([{ ...asset, amortization: null }]);

    const withYear = unwrap(listDeferredAssets(readDeps(), { fiscalYear: 2025 }));
    expect(withYear[0]?.amortization).toEqual({
      fiscalYear: 2025,
      openingBalance: 600_000,
      target: 90_000,
      decision: null,
      registered: false,
      closingBalance: 600_000,
    });
  });

  it("翌年度の上限は有効な仕訳のある決定だけで減る（仕訳のない決定・取り消した仕訳は減らさない）", () => {
    const asset = unwrap(save());
    unwrap(decide(asset.id, 2025, 90_000));
    const limit2026 = () =>
      unwrap(listDeferredAssets(readDeps(), { fiscalYear: 2026 }))[0]?.amortization?.openingBalance;
    expect(limit2026()).toBe(600_000);
    const { journal } = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "deferred_amortization",
        sourceId: asset.id,
        expected: { amount: 90_000 },
      }),
    );
    expect(limit2026()).toBe(510_000);
    unwrap(voidJournal(fx.deps, journal.id, { reason: "やり直し", version: journal.version }));
    expect(limit2026()).toBe(600_000);
  });

  it("計算できない（月数の税制の値がない）開業費の amortization は null", () => {
    unwrap(save());
    uow.closing.taxParameters = [];
    const [row] = unwrap(listDeferredAssets(readDeps(), { fiscalYear: 2025 }));
    expect(row?.amortization).toBeNull();
  });
});

describe("decideDeferredAmortization（FR-014〜015、D: §3）", () => {
  it("決定を保存し、償却の案と上限・目安を返す。仕訳はまだ作らない。deferred_amortization（create）を残す", () => {
    const asset = unwrap(save());
    const { amortization, proposal } = unwrap(decide(asset.id, 2025, 90_000));
    expect(amortization).toMatchObject({
      fiscalYear: 2025,
      openingBalance: 600_000,
      target: 90_000,
      registered: false,
      closingBalance: 510_000,
      decision: { deferredAssetId: asset.id, fiscalYear: 2025, amount: 90_000 },
    });
    expect(proposal).toMatchObject({
      kind: "deferred_amortization",
      sourceId: asset.id,
      breakdown: { amount: 90_000, openingBalance: 600_000 },
    });
    expect(fx.ledger.journals).toHaveLength(0);
    expect(uow.closing.listDeferredAmortizations()).toHaveLength(1);
    const audit = uow.closing.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "deferred_amortization",
      targetId: `${asset.id}:2025`,
      action: "create",
      beforeJson: null,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ amount: 90_000 });
  });

  it("同じ年度の再決定は更新（決定日時はそのまま、変更前・後を残す）。0 円は記録だけで案は null", () => {
    const asset = unwrap(save());
    unwrap(decide(asset.id, 2025, 90_000));
    const [first] = uow.closing.listDeferredAmortizations();
    fx.clock.value = "2026-11-01T09:00:00.000Z";
    const r = unwrap(decide(asset.id, 2025, 0));
    expect(r.proposal).toBeNull();
    expect(r.amortization.decision).toMatchObject({ amount: 0 });
    const [saved, ...rest] = uow.closing.listDeferredAmortizations();
    expect(rest).toEqual([]);
    expect(saved?.decidedAt).toBe(first?.decidedAt);
    const audit = uow.closing.audits.at(-1);
    expect(audit).toMatchObject({ targetId: `${asset.id}:2025`, action: "update" });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ amount: 90_000 });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ amount: 0 });
  });

  it("上限と同じ額は決められ、超えれば DEFERRED_AMORTIZATION_OVER_LIMIT（details.limit）で何も書かない", () => {
    const asset = unwrap(save());
    const before = snapshot();
    const over = decide(asset.id, 2025, 600_001);
    expect(!over.ok && over.error.code).toBe("DEFERRED_AMORTIZATION_OVER_LIMIT");
    expect(!over.ok && over.error.details?.limit).toBe(600_000);
    expect(codeOf(decide(asset.id, 2025, -1))).toBe("VALIDATION");
    expect(codeOf(decide(asset.id, 2025, 1.5))).toBe("VALIDATION");
    expect(snapshot()).toEqual(before);
    expect(codeOf(decide(asset.id, 2025, 600_000))).toBe("ok");
  });

  it("年度がなければ VALIDATION、開業費がなければ VALIDATION", () => {
    const asset = unwrap(save());
    expect(codeOf(decide(asset.id, 2030, 1))).toBe("VALIDATION");
    expect(codeOf(decide("missing", 2025, 1))).toBe("VALIDATION");
  });

  it("締め済みの年度は PERIOD_CLOSED（上限の検査より先）", () => {
    const asset = unwrap(save());
    fx.closeYear(2025);
    const before = snapshot();
    expect(codeOf(decide(asset.id, 2025, 1))).toBe("PERIOD_CLOSED");
    expect(codeOf(decide(asset.id, 2025, 999_999_999))).toBe("PERIOD_CLOSED");
    expect(snapshot()).toEqual(before);
  });

  it("開始年度（累計の年の翌年）より前の年度は VALIDATION", () => {
    const asset = unwrap(save({ priorAccumulated: 100_000, priorThroughYear: 2025 }));
    const r = decide(asset.id, 2025, 1);
    expect(!r.ok && r.error.code).toBe("VALIDATION");
    expect(codeOf(decide(asset.id, 2026, 1))).toBe("ok");
  });

  it("その年度に有効な償却の仕訳があれば 409（上限の検査より先）。取り消せば変えられる", () => {
    const asset = unwrap(save());
    const { journal } = registerYear(asset.id, 2025, 90_000);
    const before = snapshot();
    const r = decide(asset.id, 2025, 80_000);
    expect(!r.ok && r.error.code).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect(!r.ok && r.error.details?.years).toEqual([2025]);
    expect(codeOf(decide(asset.id, 2025, 999_999_999))).toBe("DEPRECIATION_JOURNAL_EXISTS");
    expect(snapshot()).toEqual(before);
    unwrap(voidJournal(fx.deps, journal.id, { reason: "やり直し", version: journal.version }));
    const again = unwrap(decide(asset.id, 2025, 80_000));
    expect(again.amortization).toMatchObject({ registered: false });
    expect(again.proposal).toMatchObject({ breakdown: { amount: 80_000 } });
  });

  it("別の年度の仕訳は 2025 年度の決定を止めない。2026 年度の上限は 2025 年度の有効な仕訳の分だけ減る", () => {
    const asset = unwrap(save());
    registerYear(asset.id, 2025, 90_000);
    const over = decide(asset.id, 2026, 510_001);
    expect(!over.ok && over.error.details?.limit).toBe(510_000);
    expect(codeOf(decide(asset.id, 2026, 510_000))).toBe("ok");
  });

  it("開業費の勘定・減価償却費の科目がなく案を作れなければ、決定も書かない", () => {
    const asset = unwrap(save());
    const expense = fx.masters.listAccounts().find((a) => a.code === "5180");
    if (expense === undefined) throw new Error("5180 がない");
    fx.masters.deleteAccount(expense.id);
    const before = snapshot();
    const r = decide(asset.id, 2025, 90_000);
    expect(!r.ok && r.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(snapshot()).toEqual(before);
  });
});

describe("決算書への反映（getBlueReturn、FR-019）", () => {
  it("決定の額が正の開業費は 3 ページの行になる（仕訳の登録の前でも）。0 円・決定なしは載らない", () => {
    const asset = unwrap(save());
    const rows = () =>
      unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 })).page3.depreciation.filter(
        (r) => r.source === "deferred_asset",
      );
    expect(rows()).toEqual([]);
    unwrap(decide(asset.id, 2025, 0));
    expect(rows()).toEqual([]);
    unwrap(decide(asset.id, 2025, 90_000));
    expect(rows()).toMatchObject([
      { assetId: asset.id, method: "deferred", deductible: 90_000, closingBookValue: 510_000 },
    ]);
  });

  it("前の年度の決定は、有効な仕訳があるときだけ翌年度の未償却残高を減らす", () => {
    const asset = unwrap(save());
    unwrap(decide(asset.id, 2025, 90_000));
    unwrap(decide(asset.id, 2026, 60_000));
    const closing2026 = () =>
      unwrap(getBlueReturn(readDeps(), { fiscalYear: 2026 })).page3.depreciation.find(
        (r) => r.assetId === asset.id,
      )?.closingBookValue;
    // 2025 年度の仕訳がない間は、2026 年度の上限は総額のまま
    expect(closing2026()).toBe(540_000);
    unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "deferred_amortization",
        sourceId: asset.id,
        expected: { amount: 90_000 },
      }),
    );
    expect(closing2026()).toBe(450_000);
  });

  it("締め済みでない年度の案は getAdjustmentProposals の最後に出る", () => {
    const asset = unwrap(save());
    unwrap(decide(asset.id, 2025, 90_000));
    const list = unwrap(getAdjustmentProposals(readDeps(), { fiscalYear: 2025 }));
    expect(list.map((p) => [p.kind, p.sourceId])).toEqual([["deferred_amortization", asset.id]]);
  });
});
