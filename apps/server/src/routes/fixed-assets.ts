import { disposeFixedAsset, listFixedAssets, saveFixedAsset } from "@trebuchet/domain";
import {
  FixedAssetDisposeInput,
  FixedAssetInput,
  FixedAssetsQuery,
  FixedAssetUpdateInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { closingSettingsDeps } from "../deps.ts";
import { fail, orThrow } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下の固定資産台帳（003 US3。FR-018〜023）。個人の事業体だけ */
export const fixedAssetRoutes = new Hono<TenantEnv>()
  .get("/fixed-assets", validate("query", FixedAssetsQuery), (c) => {
    const { year } = c.req.valid("query");
    const result = listFixedAssets(closingSettingsDeps(c.var.db), {
      ...(year === undefined ? {} : { fiscalYear: year }),
    });
    if (!result.ok) return fail(c, result.error);
    return c.json({ assets: result.value }, 200);
  })
  .post("/fixed-assets", validate("json", FixedAssetInput), (c) => {
    const input = c.req.valid("json");
    // 資産の保存と履歴を1つのトランザクションにする
    const asset = c.var.db.transaction((tx) =>
      orThrow(saveFixedAsset(closingSettingsDeps(tx), input)),
    );
    return c.json({ asset }, 201);
  })
  .put("/fixed-assets/:assetId", validate("json", FixedAssetUpdateInput), (c) => {
    const id = c.req.param("assetId");
    const { reason, ...fields } = c.req.valid("json");
    const asset = c.var.db.transaction((tx) =>
      orThrow(saveFixedAsset(closingSettingsDeps(tx), { ...fields, id, reason: reason ?? null })),
    );
    return c.json({ asset }, 200);
  })
  .post("/fixed-assets/:assetId/dispose", validate("json", FixedAssetDisposeInput), (c) => {
    const id = c.req.param("assetId");
    const { disposedOn, reason } = c.req.valid("json");
    const asset = c.var.db.transaction((tx) =>
      orThrow(disposeFixedAsset(closingSettingsDeps(tx), { id, disposedOn, reason })),
    );
    return c.json({ asset }, 200);
  });
