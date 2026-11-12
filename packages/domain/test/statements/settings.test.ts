import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_STATEMENT_SETTINGS,
  getStatementSettings,
  saveStatementSettings,
} from "../../src/usecases/statements.ts";
import { codeOf, unwrap } from "../result.ts";
import { setupStatements } from "../statements-setup.ts";

// 006 T014（R12、§1.8、FR-018・027）。まとめて承認・外部へ送るしきい値の設定

let ctx: ReturnType<typeof setupStatements>;
beforeEach(() => {
  ctx = setupStatements();
});

describe("getStatementSettings", () => {
  it("保存がなければ既定（まとめて承認 80、外部へ送る 60）", () => {
    expect(DEFAULT_STATEMENT_SETTINGS).toEqual({ bulkThreshold: 80, externalThreshold: 60 });
    const s = unwrap(getStatementSettings(ctx.deps));
    expect(s).toMatchObject({ bulkThreshold: 80, externalThreshold: 60 });
    // 読むだけでは書かない
    expect(ctx.uow.statements.state.settings).toBeUndefined();
    expect(ctx.uow.statements.audits).toHaveLength(0);
  });
});

describe("saveStatementSettings", () => {
  it("保存して読み直せる（往復）。更新の日時は時計の時刻", () => {
    const saved = unwrap(
      saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }),
    );
    expect(saved).toMatchObject({ bulkThreshold: 90, externalThreshold: 50 });
    expect(saved.updatedAt).toBe(ctx.deps.clock.now());
    expect(unwrap(getStatementSettings(ctx.deps))).toEqual(saved);
  });

  it("0 と 100 は有効。範囲外・整数でない値は VALIDATION で、何も書かない", () => {
    unwrap(saveStatementSettings(ctx.deps, { bulkThreshold: 0, externalThreshold: 100 }));
    const before = structuredClone(ctx.uow.statements.state.settings);
    for (const input of [
      { bulkThreshold: -1, externalThreshold: 60 },
      { bulkThreshold: 101, externalThreshold: 60 },
      { bulkThreshold: 80, externalThreshold: 100.5 },
      { bulkThreshold: Number.NaN, externalThreshold: 60 },
      { bulkThreshold: 80, externalThreshold: 1e9 },
    ]) {
      expect(codeOf(saveStatementSettings(ctx.deps, input))).toBe("VALIDATION");
    }
    expect(ctx.uow.statements.state.settings).toEqual(before);
  });

  it("変更を監査に残す（最初は create、次から update）。変更がなければ書かない", () => {
    unwrap(saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }));
    unwrap(saveStatementSettings(ctx.deps, { bulkThreshold: 90, externalThreshold: 50 }));
    unwrap(saveStatementSettings(ctx.deps, { bulkThreshold: 70, externalThreshold: 50 }));
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
