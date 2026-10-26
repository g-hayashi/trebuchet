import { beforeEach, describe, expect, it } from "vitest";
import type { Result } from "../../src/types.ts";
import {
  DEFAULT_STATEMENT_SETTINGS,
  getStatementSettings,
  saveStatementSettings,
} from "../../src/usecases/statements.ts";
import { fakeStatementUnitOfWork } from "../fakes.ts";
import { setupBase } from "../ledger-setup.ts";

// 006 T014（R12、§1.8、FR-018・027）。まとめて承認・外部へ送るしきい値の設定

function setup() {
  const base = setupBase();
  const uow = fakeStatementUnitOfWork(base.ledger, base.masters);
  return { uow, deps: { uow, ids: base.ids, clock: base.clock } };
}
let ctx: ReturnType<typeof setup>;
beforeEach(() => {
  ctx = setup();
});

const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const code = (r: Result<unknown>) => (r.ok ? "ok" : r.error.code);

describe("getStatementSettings", () => {
  it("保存がなければ既定（まとめて承認 80、外部へ送る 60）", () => {
    expect(DEFAULT_STATEMENT_SETTINGS).toEqual({ bulkThreshold: 80, externalThreshold: 60 });
    const s = ok(getStatementSettings(ctx.deps));
    expect(s).toMatchObject({ bulkThreshold: 80, externalThreshold: 60 });
    // 読むだけでは書かない
    expect(ctx.uow.statements.state.settings).toBeUndefined();
    expect(ctx.uow.statements.audits).toHaveLength(0);
  });
});

describe("saveStatementSettings", () => {
  it("保存して読み直せる（往復）。更新の日時は時計の時刻", () => {
    const saved = ok(saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }));
    expect(saved).toMatchObject({ bulkThreshold: 90, externalThreshold: 50 });
    expect(saved.updatedAt).toBe(ctx.deps.clock.now());
    expect(ok(getStatementSettings(ctx.deps))).toEqual(saved);
  });

  it("0 と 100 は有効。範囲外・整数でない値は VALIDATION で、何も書かない", () => {
    ok(saveStatementSettings(ctx.deps, { bulkThreshold: 0, externalThreshold: 100 }));
    const before = structuredClone(ctx.uow.statements.state.settings);
    for (const input of [
      { bulkThreshold: -1, externalThreshold: 60 },
      { bulkThreshold: 101, externalThreshold: 60 },
      { bulkThreshold: 80, externalThreshold: 100.5 },
      { bulkThreshold: Number.NaN, externalThreshold: 60 },
      { bulkThreshold: 80, externalThreshold: 1e9 },
    ]) {
      expect(code(saveStatementSettings(ctx.deps, input))).toBe("VALIDATION");
    }
    expect(ctx.uow.statements.state.settings).toEqual(before);
  });

  it("変更を監査に残す（最初は create、次から update）。変更がなければ書かない", () => {
    ok(saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }));
    ok(saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }));
    ok(saveStatementSettings(ctx.deps, { bulkThreshold: 70, externalThreshold: 50 }));
    const audits = ctx.uow.statements.audits;
    expect(audits.map((a) => [a.targetType, a.action])).toEqual([
      ["statement_settings", "create"],
      ["statement_settings", "update"],
    ]);
    expect(audits[0]?.beforeJson).toBeNull();
    expect(JSON.parse(audits[1]?.beforeJson ?? "{}")).toMatchObject({ bulkThreshold: 90 });
    expect(JSON.parse(audits[1]?.afterJson ?? "{}")).toMatchObject({ bulkThreshold: 70 });
  });
});
