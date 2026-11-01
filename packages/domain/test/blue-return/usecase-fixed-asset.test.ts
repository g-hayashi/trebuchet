import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import {
  commitAdjustment,
  disposeFixedAsset,
  getAdjustmentProposals,
  getBlueReturn,
  listFixedAssets,
  saveFixedAsset,
} from "../../src/usecases/blue-return.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { type FakeClosingUnitOfWork, fakeClosingUnitOfWork } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

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
const readDeps = () => ({ ...settingsDeps(), reports: reports() });
const commitDeps = () => ({ uow, reports: reports(), ids: fx.ids, clock: fx.clock });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const input = (over: Record<string, unknown> = {}) => ({
  name: "ノートパソコン",
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2" as const,
  priorAccumulated: 0,
  businessRatio: 10000,
  assetAccountId: fx.accountId("工具器具備品"),
  ...over,
});

const save = (over: Record<string, unknown> = {}) => saveFixedAsset(settingsDeps(), input(over));
const proposals = () => unwrap(getAdjustmentProposals(readDeps(), { fiscalYear: 2025 }));
const blue = () => unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
const snapshot = () =>
  structuredClone({
    ledger: fx.ledger.state,
    closing: uow.closing.state,
    masters: fx.masters.state,
  });

describe("saveFixedAsset（FR-018〜020）", () => {
  it("登録すると ID と日時を付け、closing_audit_log に fixed_asset（create）を残す", () => {
    const asset = unwrap(save({ note: "業務用" }));
    expect(asset).toMatchObject({
      name: "ノートパソコン",
      acquisitionCost: 200_000,
      method: "small_asset_28_2",
      businessRatio: 10000,
      linkedJournalId: null,
      note: "業務用",
      disposedOn: null,
      createdAt: "2026-10-31T09:00:00.000Z",
    });
    expect(uow.closing.listFixedAssets()).toEqual([asset]);
    const [audit, ...rest] = uow.closing.audits;
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({
      targetType: "fixed_asset",
      targetId: asset.id,
      action: "create",
      beforeJson: null,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ id: asset.id });
  });

  it("id を付けると更新する。作成日時と除却の日はそのまま、理由と変更前・後を残す", () => {
    const created = unwrap(save());
    const updated = unwrap(
      saveFixedAsset(settingsDeps(), {
        ...input({ businessRatio: 5000 }),
        id: created.id,
        reason: "事業専用割合の見直し",
      }),
    );
    expect(updated).toMatchObject({
      id: created.id,
      businessRatio: 5000,
      createdAt: created.createdAt,
    });
    expect(uow.closing.listFixedAssets()).toHaveLength(1);
    const audit = uow.closing.audits[1];
    expect(audit).toMatchObject({
      targetType: "fixed_asset",
      targetId: created.id,
      action: "update",
      reason: "事業専用割合の見直し",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ businessRatio: 10000 });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ businessRatio: 5000 });
  });

  it("存在しない id の更新は VALIDATION", () => {
    const r = saveFixedAsset(settingsDeps(), { ...input(), id: "missing" });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });

  it("検査に落ちれば何も書かない（5つのエラーコード）", () => {
    const before = snapshot();
    const code = (over: Record<string, unknown>) => {
      const r = save(over);
      return r.ok ? "ok" : r.error.code;
    };
    expect(code({ assetAccountId: fx.accountId("減価償却費") })).toBe("ASSET_ACCOUNT_INVALID");
    expect(code({ acquisitionCost: 300_000 })).toBe("SMALL_ASSET_OVER_THRESHOLD");
    expect(code({ acquiredOn: "2029-04-01" })).toBe("SMALL_ASSET_NOT_APPLICABLE");
    expect(code({ method: "declining_balance" })).toBe("DEPRECIATION_METHOD_UNSUPPORTED");
    expect(snapshot()).toEqual(before);
    for (let i = 0; i < 10; i++) {
      expect(code({ acquisitionCost: 299_000, name: `備品${i}` })).toBe("ok");
    }
    expect(code({ acquisitionCost: 299_000 })).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
  });

  it("年間の上限は同じ年の特例の資産で数え、更新のとき自分自身は数えない", () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(unwrap(save({ acquisitionCost: 299_000, name: `備品${i}` })).id);
    }
    // 2,990,000 円。1 件を 299,000 → 300,000 未満のまま変更しても、自分自身は数えない
    const r = saveFixedAsset(settingsDeps(), {
      ...input({ acquisitionCost: 299_500, name: "備品0" }),
      id: ids[0] ?? "",
    });
    expect(r.ok).toBe(true);
    // 別の年は別枠
    expect(save({ acquisitionCost: 299_000, acquiredOn: "2026-02-01" }).ok).toBe(true);
  });

  it("締め済みの年度でも台帳には登録できる", () => {
    fx.closeYear(2025);
    expect(save().ok).toBe(true);
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED", () => {
    const profile = fx.masters.getProfile();
    if (profile === undefined) throw new Error("no profile");
    fx.masters.saveProfile({ ...profile, kind: "corporation" });
    const r = save();
    expect(!r.ok && r.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
  });
});

describe("listFixedAssets（FR-018、FR-023）", () => {
  it("year を付けると各資産にその年の depreciation を付け、付けなければ null", () => {
    const asset = unwrap(save({ businessRatio: 5000 }));
    const withYear = unwrap(listFixedAssets(settingsDeps(), { fiscalYear: 2025 }));
    expect(withYear).toEqual([
      {
        ...asset,
        depreciation: {
          method: "small_asset_28_2",
          cost: 200_000,
          base: 200_000,
          ratePermille: null,
          months: null,
          openingBookValue: 200_000,
          ordinary: 200_000,
          total: 200_000,
          businessRatio: 5000,
          deductible: 100_000,
          closingBookValue: 0,
          disposalKind: null,
          disposalAmount: 0,
          disposalDeductible: 0,
        },
      },
    ]);
    const other = unwrap(listFixedAssets(settingsDeps(), { fiscalYear: 2026 }));
    expect(other[0]?.depreciation).toMatchObject({ total: 0, deductible: 0 });
    const none = unwrap(listFixedAssets(settingsDeps(), {}));
    expect(none).toEqual([{ ...asset, depreciation: null }]);
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED", () => {
    const profile = fx.masters.getProfile();
    if (profile === undefined) throw new Error("no profile");
    fx.masters.saveProfile({ ...profile, kind: "corporation" });
    const r = listFixedAssets(settingsDeps(), {});
    expect(!r.ok && r.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
  });
});

describe("disposeFixedAsset", () => {
  it("除却の日を記録し、closing_audit_log に fixed_asset（dispose）を残す。物理削除はしない", () => {
    const asset = unwrap(save());
    const disposed = unwrap(
      disposeFixedAsset(settingsDeps(), {
        id: asset.id,
        disposedOn: "2026-03-01",
        reason: "売却",
      }),
    );
    expect(disposed).toMatchObject({ id: asset.id, disposedOn: "2026-03-01" });
    expect(uow.closing.listFixedAssets()).toEqual([disposed]);
    const audit = uow.closing.audits[1];
    expect(audit).toMatchObject({
      targetType: "fixed_asset",
      targetId: asset.id,
      action: "dispose",
      reason: "売却",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ disposedOn: null });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({ disposedOn: "2026-03-01" });
  });

  it("存在しない資産、取得の日より前の除却の日は VALIDATION。何も書かない", () => {
    const asset = unwrap(save());
    const before = snapshot();
    const missing = disposeFixedAsset(settingsDeps(), {
      id: "missing",
      disposedOn: "2026-03-01",
      reason: "売却",
    });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");
    const early = disposeFixedAsset(settingsDeps(), {
      id: asset.id,
      disposedOn: "2025-06-14",
      reason: "売却",
    });
    expect(!early.ok && early.error.code).toBe("VALIDATION");
    expect(snapshot()).toEqual(before);
  });

  it("取得して同じ年に除却した資産も同じ年の上限の合計に数える（特例を使ったため）", () => {
    for (let i = 0; i < 10; i++) unwrap(save({ acquisitionCost: 299_000, name: `備品${i}` }));
    expect(save({ acquisitionCost: 299_000 }).ok).toBe(false);
    const [first] = uow.closing.listFixedAssets();
    unwrap(
      disposeFixedAsset(settingsDeps(), {
        id: first?.id ?? "",
        disposedOn: "2025-12-01",
        reason: "廃棄",
      }),
    );
    const r = save({ acquisitionCost: 299_000 });
    expect(!r.ok && r.error.code).toBe("SMALL_ASSET_ANNUAL_LIMIT_EXCEEDED");
  });
});

describe("減価償却の案の確定（FR-021〜023、R4・R7）", () => {
  it("シナリオ1: 割合 100% の資産の案を確定すると、3ページと欄18 が一致して警告が消える", () => {
    const asset = unwrap(save());
    const [proposal, ...rest] = proposals();
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      kind: "depreciation",
      sourceId: asset.id,
      breakdown: { acquisitionCost: 200_000, businessRatio: 10000, deductible: 200_000 },
    });
    // 仕訳の前は、3ページの表はあるが欄18 は 0 で警告する
    const before = blue();
    expect(before.page3.depreciation).toHaveLength(1);
    expect(before.warnings.map((w) => w.code)).toContain("DEPRECIATION_MISMATCH");

    const committed = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "depreciation",
        sourceId: asset.id,
        expected: { amount: 200_000 },
      }),
    );
    expect(committed.journal).toMatchObject({ date: "2025-12-31", source: "manual" });
    expect(committed.journal.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", fx.accountId("減価償却費"), 200_000],
      ["credit", fx.accountId("工具器具備品"), 200_000],
    ]);
    expect(committed.ref).toEqual({
      journalId: committed.journal.id,
      kind: "depreciation",
      allocationId: null,
      assetId: asset.id,
      deferredAssetId: null,
      fiscalYear: 2025,
    });
    expect(uow.closing.listAdjustmentRefs(2025)).toEqual([committed.ref]);
    expect(proposals()).toEqual([]);

    const after = blue();
    expect(after.page1.lines.find((l) => l.no === 18)?.amount).toBe(200_000);
    expect(after.warnings.map((w) => w.code)).not.toContain("DEPRECIATION_MISMATCH");
  });

  it("シナリオ4: 割合 50% は家事分の振替が加わり、確定の金額は借方合計（取得価額 + 家事分）", () => {
    const asset = unwrap(save({ businessRatio: 5000 }));
    const [proposal] = proposals();
    expect(proposal?.breakdown).toMatchObject({ deductible: 100_000 });
    expect(
      unwrap(
        commitAdjustment(commitDeps(), {
          fiscalYear: 2025,
          kind: "depreciation",
          sourceId: asset.id,
          expected: { amount: 300_000 },
        }),
      ).journal.lines.map((l) => [l.side, l.accountId, l.amount]),
    ).toEqual([
      ["debit", fx.accountId("減価償却費"), 200_000],
      ["credit", fx.accountId("工具器具備品"), 200_000],
      ["debit", fx.accountId("事業主貸"), 100_000],
      ["credit", fx.accountId("減価償却費"), 100_000],
    ]);
    const after = blue();
    expect(after.page1.lines.find((l) => l.no === 18)?.amount).toBe(100_000);
    expect(after.warnings.map((w) => w.code)).not.toContain("DEPRECIATION_MISMATCH");
  });

  it("課税期間の帳簿でも、案の仕訳の行の税区分は対象外", () => {
    fx.masters.replaceTaxSettings([
      {
        id: "ts-1",
        effectiveFrom: "2025-01-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const asset = unwrap(save({ businessRatio: 5000 }));
    const committed = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "depreciation",
        sourceId: asset.id,
        expected: { amount: 300_000 },
      }),
    );
    expect(committed.journal.lines.map((l) => l.taxCategory)).toEqual([
      "OUT_OF_SCOPE",
      "OUT_OF_SCOPE",
      "OUT_OF_SCOPE",
      "OUT_OF_SCOPE",
    ]);
  });

  it("登録済みの資産の案は出ない。登録した仕訳を取り消せば案が戻る", () => {
    const asset = unwrap(save());
    const committed = unwrap(
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "depreciation",
        sourceId: asset.id,
        expected: { amount: 200_000 },
      }),
    );
    const again = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: asset.id,
      expected: { amount: 200_000 },
    });
    expect(!again.ok && again.error.code).toBe("ADJUSTMENT_NOT_NEEDED");
    unwrap(
      voidJournal(fx.deps, committed.journal.id, {
        reason: "やり直し",
        version: committed.journal.version,
      }),
    );
    expect(proposals()).toHaveLength(1);
  });

  it("シナリオ5: 既存の仕訳を結びつけた資産は案を作らず、3ページの表には載る", () => {
    const expense = fx.create({
      date: "2025-06-15",
      memo: "PC",
      lines: [fx.line("debit", "減価償却費", 200_000), fx.line("credit", "現金", 200_000)],
    });
    const asset = unwrap(save({ linkedJournalId: expense.id }));
    expect(proposals()).toEqual([]);
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: asset.id,
      expected: { amount: 200_000 },
    });
    expect(!r.ok && r.error.code).toBe("ADJUSTMENT_NOT_NEEDED");
    const b = blue();
    expect(b.page3.depreciation.map((d) => d.assetId)).toEqual([asset.id]);
    expect(b.warnings.map((w) => w.code)).not.toContain("DEPRECIATION_MISMATCH");
  });

  it("取得した年以外・除却した資産の案は出ない", () => {
    unwrap(save({ acquiredOn: "2026-02-01" }));
    const gone = unwrap(save({ name: "除却" }));
    unwrap(
      disposeFixedAsset(settingsDeps(), { id: gone.id, disposedOn: "2025-12-01", reason: "廃棄" }),
    );
    expect(proposals()).toEqual([]);
  });

  it("画面が見た金額と違えば ADJUSTMENT_CHANGED（details.proposal）で何も書かない", () => {
    const asset = unwrap(save({ businessRatio: 5000 }));
    const before = snapshot();
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: asset.id,
      expected: { amount: 200_000 },
    });
    expect(!r.ok && r.error.code).toBe("ADJUSTMENT_CHANGED");
    expect(!r.ok && r.error.details).toMatchObject({ expected: 200_000, actual: 300_000 });
    expect(snapshot()).toEqual(before);
  });

  it("締め済みの年度は PERIOD_CLOSED（締めの解除を案内）で何も書かない", () => {
    const asset = unwrap(save());
    fx.closeYear(2025);
    const before = snapshot();
    const r = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: asset.id,
      expected: { amount: 200_000 },
    });
    expect(!r.ok && r.error.code).toBe("PERIOD_CLOSED");
    expect(!r.ok && r.error.details?.suggest).toBe("reopen_period");
    expect(snapshot()).toEqual(before);
  });

  it("資産が見つからなければ VALIDATION。参照の登録で例外が出ると仕訳も残らない", () => {
    const missing = commitAdjustment(commitDeps(), {
      fiscalYear: 2025,
      kind: "depreciation",
      sourceId: "missing",
      expected: { amount: 1 },
    });
    expect(!missing.ok && missing.error.code).toBe("VALIDATION");

    const asset = unwrap(save());
    const before = snapshot();
    vi.spyOn(uow.closing, "insertAdjustmentRef").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    expect(() =>
      commitAdjustment(commitDeps(), {
        fiscalYear: 2025,
        kind: "depreciation",
        sourceId: asset.id,
        expected: { amount: 200_000 },
      }),
    ).toThrow("disk I/O error");
    expect(snapshot()).toEqual(before);
  });
});
