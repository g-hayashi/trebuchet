import { DeferredAmortizationParam, FiscalYearParam } from "@trebuchet/schema";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { validate } from "../src/validator.ts";
import { errorOf } from "./helpers.ts";

// パスの `:year`（FiscalYearParam）の検査は validator.ts の 1 か所。各ルートのテストには重複して書かない

const app = new Hono()
  .get("/fiscal/:year", validate("param", FiscalYearParam), (c) => c.json(c.req.valid("param")))
  .put(
    "/assets/:deferredAssetId/amortizations/:year",
    validate("param", DeferredAmortizationParam),
    (c) => c.json(c.req.valid("param")),
  );

describe("validate('param', FiscalYearParam)", () => {
  it("4 桁の年は数値にして通す", async () => {
    const res = await app.request("/fiscal/2026");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ year: 2026 });
  });

  it.each(["26", "20266", "abcd"])(
    "年が 4 桁でなければ（%s）400 VALIDATION で、会計期間が見つからない応答にする",
    async (year) => {
      const res = await app.request(`/fiscal/${year}`);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("VALIDATION");
      expect(error.message).toContain("会計期間が見つかりません");
    },
  );

  it("year を持つ別のパスの schema（FiscalYearParam を拡張したもの）でも同じ応答にする", async () => {
    const ok = await app.request("/assets/a1/amortizations/2026", { method: "PUT" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deferredAssetId: "a1", year: 2026 });

    const res = await app.request("/assets/a1/amortizations/26", { method: "PUT" });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("会計期間が見つかりません");
  });
});
