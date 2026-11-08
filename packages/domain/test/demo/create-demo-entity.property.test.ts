import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDemoEntity } from "../../src/usecases/demo-entity.ts";
import { type DemoSetup, type Fault, setupDemo } from "./demo-setup.ts";

// INV-77（014 data-model §4）: デモの作成は全部か無か。途中のどの段階で失敗させても、registry に
// preparing の行も新しい active の行も残らず、そのテナントの DB ファイル・証憑のファイルも残らない。
// 成功したときは、demo の active の行がちょうど 1 つ増える

const TODAY = "2026-11-08";

/** 失敗させずに作って、投入のユースケースの `run`・`transaction` の呼び出しの総数 N を数える */
const baseline = (() => {
  const s = setupDemo();
  const result = createDemoEntity(s.deps, { today: TODAY });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return s.counter.n;
})();

/** 失敗の場所: 0 = createEntity の登録、1..N = 投入のユースケース、N + 1 = activateEntity */
const arbPoint = fc.integer({ min: 0, max: baseline + 1 });
const arbMode = fc.constantFrom<Fault["mode"]>("err", "throw");

function setupAt(point: number, mode: Fault["mode"]): DemoSetup {
  if (point === 0) return setupDemo({ failOnInsert: true });
  if (point === baseline + 1) return setupDemo({ failOnActivate: true });
  return setupDemo({ fault: { at: point, mode } });
}

describe("createDemoEntity の全部か無か（INV-77）", () => {
  it("投入のユースケースが十分な数ある（件数の見積もり）", () => {
    expect(baseline).toBeGreaterThan(40);
  });

  it("任意の場所で err・例外を注入すると、後片づけが呼ばれ、事業体・ファイルが残らず、DEMO_FAILED", () => {
    fc.assert(
      fc.property(arbPoint, arbMode, (point, mode) => {
        const s = setupAt(point, mode);
        const result = createDemoEntity(s.deps, { today: TODAY });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("DEMO_FAILED");
        // 後片づけ（purgeEntityData 相当）がちょうど 1 回、作りかけの事業体に対して呼ばれる
        expect(s.purged).toHaveLength(1);
        // preparing も active も残らない
        expect(s.registry.listEntities()).toEqual([]);
        expect(s.registry.listPreparingEntities()).toEqual([]);
        // テナントの DB ファイル・証憑のファイルも残らない
        expect(s.tenantFiles.size).toBe(0);
        expect(s.files.files.size).toBe(0);
        // 有効化されていない（activateEntity が成功していない）
        expect(s.activated).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("全部の場所を 1 回ずつ（err・例外とも）試しても残らない", () => {
    for (let point = 0; point <= baseline + 1; point++) {
      for (const mode of ["err", "throw"] as const) {
        const s = setupAt(point, mode);
        const result = createDemoEntity(s.deps, { today: TODAY });
        expect(result.ok, `point ${point} ${mode}`).toBe(false);
        expect(s.registry.listEntities(), `point ${point} ${mode}`).toEqual([]);
        expect(s.registry.listPreparingEntities(), `point ${point} ${mode}`).toEqual([]);
        expect(s.tenantFiles.size, `point ${point} ${mode}`).toBe(0);
        expect(s.files.files.size, `point ${point} ${mode}`).toBe(0);
      }
    }
  });

  it("成功したときは、demo の active の行がちょうど 1 つ増え、後片づけは呼ばれない", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("2026-11-08", "2026-03-01", "2027-01-20", "2026-12-31"),
        (today) => {
          const s = setupDemo({ now: `${today}T03:00:00.000Z` });
          const result = createDemoEntity(s.deps, { today });
          expect(result.ok).toBe(true);
          expect(s.registry.listEntities()).toHaveLength(1);
          expect(s.registry.listEntities()[0]?.demo).toBe(true);
          expect(s.registry.listPreparingEntities()).toEqual([]);
          expect(s.purged).toEqual([]);
          expect(s.tenantFiles.size).toBe(1);
        },
      ),
      { numRuns: 8 },
    );
  });
});
