import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { auditEntry } from "../src/audit.ts";
import { FixedClock, SequentialIds } from "./fakes.ts";

// 監査の記録を作るヘルパー。各ユースケースが手で書いていたリテラルと同じ形を作る:
// before・after は null・undefined なら null、それ以外は JSON.stringify。reason は省略で null。
// occurredAt は at を渡せばその値、なければ clock.now()

const deps = () => ({
  ids: new SequentialIds(),
  clock: new FixedClock("2026-10-25T00:00:00.000Z"),
});

describe("auditEntry", () => {
  it("リテラルで書いていたときと同じ形を作る", () => {
    fc.assert(
      fc.property(
        fc.option(fc.jsonValue(), { nil: undefined }),
        fc.option(fc.jsonValue(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.constant("2026-01-01T00:00:00.000Z"), { nil: undefined }),
        (before, after, reason, at) => {
          const d = deps();
          const expectedId = new SequentialIds().next();
          const entry = auditEntry(d, {
            targetType: "journal",
            targetId: "t-1",
            action: "create",
            before,
            after,
            ...(reason === undefined ? {} : { reason }),
            ...(at === undefined ? {} : { at }),
          });
          const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
          expect(entry).toEqual({
            id: expectedId,
            occurredAt: at ?? "2026-10-25T00:00:00.000Z",
            targetType: "journal",
            targetId: "t-1",
            action: "create",
            reason: reason ?? null,
            beforeJson: json(before),
            afterJson: json(after),
          });
        },
      ),
    );
  });

  it("空の配列・オブジェクトは null ではなく JSON にする", () => {
    const entry = auditEntry(deps(), {
      targetType: "opening_balance",
      targetId: "p",
      action: "replace",
      before: [],
      after: {},
    });
    expect(entry.beforeJson).toBe("[]");
    expect(entry.afterJson).toBe("{}");
  });
});
