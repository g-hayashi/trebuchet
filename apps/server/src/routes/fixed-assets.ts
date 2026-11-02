import { disposeFixedAsset, listFixedAssets, saveFixedAsset } from "@trebuchet/domain";
import {
  FixedAssetDisposeInput,
  FixedAssetInput,
  FixedAssetsQuery,
  FixedAssetUpdateInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { closingSettingsDeps, type RouteOptions } from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下の固定資産台帳（003 US3。FR-018〜023）。個人の事業体だけ */
export function fixedAssetRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/fixed-assets", validate("query", FixedAssetsQuery), (c) => {
      const { year } = c.req.valid("query");
      const result = listFixedAssets(closingSettingsDeps(c.var.db, clock), {
        ...(year === undefined ? {} : { fiscalYear: year }),
      });
      return respond(c, result, (assets) => c.json({ assets }, 200));
    })
    .post("/fixed-assets", validate("json", FixedAssetInput), (c) => {
      const result = saveFixedAsset(closingSettingsDeps(c.var.db, clock), c.req.valid("json"));
      return respond(c, result, (asset) => c.json({ asset }, 201));
    })
    .put("/fixed-assets/:assetId", validate("json", FixedAssetUpdateInput), (c) => {
      const id = c.req.param("assetId");
      const { reason, ...fields } = c.req.valid("json");
      const result = saveFixedAsset(closingSettingsDeps(c.var.db, clock), {
        ...fields,
        id,
        reason: reason ?? null,
      });
      return respond(c, result, (asset) => c.json({ asset }, 200));
    })
    .post("/fixed-assets/:assetId/dispose", validate("json", FixedAssetDisposeInput), (c) => {
      const id = c.req.param("assetId");
      const { disposedOn, reason, disposalKind } = c.req.valid("json");
      const result = disposeFixedAsset(closingSettingsDeps(c.var.db, clock), {
        id,
        disposedOn,
        reason,
        disposalKind,
      });
      return respond(c, result, (asset) => c.json({ asset }, 200));
    });
}
