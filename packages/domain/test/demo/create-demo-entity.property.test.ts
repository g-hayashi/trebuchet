import { describe, expect, it } from "vitest";
import { createDemoEntity } from "../../src/usecases/demo-entity.ts";
import { TODAY } from "../test-dates.ts";
import { type DemoSetup, type Fault, setupDemo } from "./demo-setup.ts";

// INV-77（014 data-model §4）: デモの作成は全部か無か。途中のどの段階で失敗させても、registry に
// preparing の行も新しい active の行も残らず、そのテナントの DB ファイル・証憑のファイルも残らない。
// 成功したときは、demo の active の行がちょうど 1 つ増える。
// 失敗の場所は有限（0..N + 1）で、err・例外の 2 通りだけなので、乱数を使わず全部を 1 回ずつ試す

/** 失敗させずに作って、投入のユースケースの `run`・`transaction` の呼び出しの総数 N を数える */
const baseline = (() => {
  const s = setupDemo();
  const result = createDemoEntity(s.deps, { today: TODAY });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return s.counter.n;
})();

function setupAt(point: number, mode: Fault["mode"]): DemoSetup {
  if (point === 0) return setupDemo({ failOnInsert: true });
  if (point === baseline + 1) return setupDemo({ failOnActivate: true });
  return setupDemo({ fault: { at: point, mode } });
}

describe("createDemoEntity の全部か無か（INV-77）", () => {
  it("投入のユースケースが十分な数ある（件数の見積もり）", () => {
    expect(baseline).toBeGreaterThan(40);
  });

  // 失敗の場所: 0 = createEntity の登録、1..N = 投入のユースケース、N + 1 = activateEntity
  it("全部の場所を 1 回ずつ（err・例外とも）試すと、後片づけが呼ばれ、事業体・ファイルが残らず、DEMO_FAILED", () => {
    for (let point = 0; point <= baseline + 1; point++) {
      for (const mode of ["err", "throw"] as const) {
        const at = `point ${point} ${mode}`;
        const s = setupAt(point, mode);
        const result = createDemoEntity(s.deps, { today: TODAY });
        expect(result.ok, at).toBe(false);
        if (result.ok) return;
        expect(result.error.code, at).toBe("DEMO_FAILED");
        // 後片づけ（purgeEntityData 相当）がちょうど 1 回、作りかけの事業体に対して呼ばれる
        expect(s.purged, at).toHaveLength(1);
        // preparing も active も残らない
        expect(s.registry.listEntities(), at).toEqual([]);
        expect(s.registry.listPreparingEntities(), at).toEqual([]);
        // テナントの DB ファイル・証憑のファイルも残らない
        expect(s.tenantFiles.size, at).toBe(0);
        expect(s.files.files.size, at).toBe(0);
        // 有効化されていない（activateEntity が成功していない）
        expect(s.activated, at).toEqual([]);
      }
    }
  });

  it.each(["2026-11-08", "2026-03-01", "2027-01-20", "2026-12-31"])(
    "成功したときは、demo の active の行がちょうど 1 つ増え、後片づけは呼ばれない（%s）",
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
  );
});
