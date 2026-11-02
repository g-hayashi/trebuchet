import {
  decideDeferredAmortization,
  listDeferredAssets,
  saveDeferredAsset,
} from "@trebuchet/domain";
import {
  DeferredAmortizationInput,
  DeferredAmortizationParam,
  DeferredAssetInput,
  DeferredAssetUpdateInput,
  FixedAssetsQuery,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { blueReturnDeps, closingSettingsDeps, type RouteOptions } from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下の繰延資産（開業費。009 US3。FR-012〜015）。個人の事業体だけ */
export function deferredAssetRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/deferred-assets", validate("query", FixedAssetsQuery), (c) => {
      const { year } = c.req.valid("query");
      const result = listDeferredAssets(blueReturnDeps(c.var.db), {
        ...(year === undefined ? {} : { fiscalYear: year }),
      });
      return respond(c, result, (deferredAssets) => c.json({ deferredAssets }, 200));
    })
    .post("/deferred-assets", validate("json", DeferredAssetInput), (c) => {
      const result = saveDeferredAsset(closingSettingsDeps(c.var.db, clock), c.req.valid("json"));
      return respond(c, result, (deferredAsset) => c.json({ deferredAsset }, 201));
    })
    .put("/deferred-assets/:deferredAssetId", validate("json", DeferredAssetUpdateInput), (c) => {
      const id = c.req.param("deferredAssetId");
      const { reason, ...fields } = c.req.valid("json");
      const result = saveDeferredAsset(closingSettingsDeps(c.var.db, clock), {
        ...fields,
        id,
        reason: reason ?? null,
      });
      return respond(c, result, (deferredAsset) => c.json({ deferredAsset }, 200));
    })
    .put(
      "/deferred-assets/:deferredAssetId/amortizations/:year",
      validate("param", DeferredAmortizationParam),
      validate("json", DeferredAmortizationInput),
      (c) => {
        const { deferredAssetId, year } = c.req.valid("param");
        const { amount } = c.req.valid("json");
        const result = decideDeferredAmortization(closingSettingsDeps(c.var.db, clock), {
          deferredAssetId,
          fiscalYear: year,
          amount,
        });
        return respond(c, result, ({ amortization, proposal }) =>
          c.json({ amortization, proposal }, 200),
        );
      },
    );
}
