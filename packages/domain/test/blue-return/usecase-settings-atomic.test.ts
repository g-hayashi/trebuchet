import { beforeEach, describe, expect, it, vi } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import type { Result } from "../../src/types.ts";
import {
  disposeFixedAsset,
  saveClosingNote,
  saveDeductionAnswers,
  saveFixedAsset,
  saveHomeUseAllocation,
  saveRentDetails,
} from "../../src/usecases/blue-return.ts";
import { type FakeClosingUnitOfWork, fakeClosingUnitOfWork } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";

// 決算の設定の保存は、保存と closing_audit_log の記録を 1 つの UnitOfWork で書く。
// 記録が失敗すれば保存も残らない（以前はルートの db.transaction が担っていた）

let fx: ReturnType<typeof setupLedger>;
let uow: FakeClosingUnitOfWork;

beforeEach(() => {
  fx = setupLedger();
  uow = fakeClosingUnitOfWork(fx.ledger, fx.masters);
  uow.closing.taxParameters = [...TAX_PARAMETERS];
});

const deps = () => ({ uow, ids: fx.ids, clock: fx.clock });

const asset = () => ({
  name: "ノートパソコン",
  acquiredOn: "2025-06-15",
  acquisitionCost: 200_000,
  method: "small_asset_28_2" as const,
  priorAccumulated: 0,
  businessRatio: 10000,
  assetAccountId: fx.accountId("工具器具備品"),
});

const SAVES: [string, () => Result<unknown>][] = [
  [
    "saveClosingNote",
    () => saveClosingNote(deps(), { fiscalYear: 2025, kind: "special_circumstances", body: "x" }),
  ],
  [
    "saveDeductionAnswers",
    () =>
      saveDeductionAnswers(deps(), {
        fiscalYear: 2025,
        answers: {
          doubleEntry: true,
          statementsAttached: true,
          filedOnTime: true,
          eTax: true,
          electronicBooks: false,
        },
      }),
  ],
  [
    "saveHomeUseAllocation",
    () =>
      saveHomeUseAllocation(deps(), {
        fiscalYear: 2025,
        accountId: fx.accountId("地代家賃"),
        businessRatio: 3000,
        basis: "床面積",
      }),
  ],
  [
    "saveRentDetails",
    () =>
      saveRentDetails(deps(), {
        fiscalYear: 2025,
        rows: [{ payee: "大家A", property: "事務所", annualRent: 100, deductibleAmount: 50 }],
      }),
  ],
  ["saveFixedAsset", () => saveFixedAsset(deps(), asset())],
];

const state = () => structuredClone({ closing: uow.closing.state, masters: fx.masters.state });

describe("決算の設定の保存の原子性", () => {
  it.each(SAVES)("%s: 正常なら保存と記録が 1 件ずつ残る", (_, save) => {
    expect(save().ok).toBe(true);
    expect(uow.closing.audits).toHaveLength(1);
  });

  it.each(SAVES)("%s: 記録の書き込みが例外なら、保存も残らない", (_, save) => {
    const before = state();
    vi.spyOn(uow.closing, "appendClosingAudit").mockImplementation(() => {
      throw new Error("記録の失敗");
    });
    expect(save).toThrow("記録の失敗");
    expect(state()).toEqual(before);
  });

  it("disposeFixedAsset: 記録の書き込みが例外なら、除却の日も残らない", () => {
    const saved = saveFixedAsset(deps(), asset());
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const before = state();
    vi.spyOn(uow.closing, "appendClosingAudit").mockImplementation(() => {
      throw new Error("記録の失敗");
    });
    expect(() =>
      disposeFixedAsset(deps(), { id: saved.value.id, disposedOn: "2025-12-31", reason: "故障" }),
    ).toThrow("記録の失敗");
    expect(state()).toEqual(before);
    expect(uow.closing.listFixedAssets()[0]?.disposedOn).toBeNull();
  });
});
