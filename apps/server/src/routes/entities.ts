import { DrizzleMasterRepository, openTenant } from "@trebuchet/db";
import {
  createDemoEntity,
  createEntity,
  type DemoAssets,
  manageEntity,
  renameEntity,
} from "@trebuchet/domain";
import { EntityCreate, EntityPatch } from "@trebuchet/schema";
import { Hono } from "hono";
import { loadDemoAssets } from "../demo-assets.ts";
import {
  defaultReceiptRuntime,
  demoEntityDeps,
  type ReceiptRuntime,
  type RouteOptions,
  registryRepository,
} from "../deps.ts";
import { fail, respond } from "../errors.ts";
import { ids } from "../lib/ids.ts";
import { todayOf } from "../lib/today.ts";
import { hasActiveEntityRequests, type TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** デモ事業を作っている最中か（プロセス内の排他。014 R6）。同時の 2 つ目は 409 */
let creatingDemo = false;

/** `/api/entities`（テナントのミドルウェアの外） */
export function entitiesRoutes({
  clock,
  demo,
  files,
  imageTool,
}: RouteOptions & {
  /** デモ事業の素材の差し替え口（既定は同梱の画像。寸法は `imageTool` で調べる） */
  demo?: { assets?: DemoAssets };
  /** 証憑のファイルの置き場の差し替え口（`createApp({ receipts })` と同じもの） */
  files?: ReceiptRuntime["files"];
  /** 同梱の画像の寸法を調べる変換器（`createApp({ receipts })` と同じもの。既定は sips） */
  imageTool?: ReceiptRuntime["imageTool"];
}) {
  return new Hono()
    .post("/demo", async (c) => {
      if (creatingDemo) {
        return fail(c, {
          code: "DEMO_NOT_AVAILABLE",
          message: "デモ事業を作成中です",
        });
      }
      // 排他は await の前に取る（寸法の読み取りの間に 2 つ目が入らないように）
      creatingDemo = true;
      try {
        // createDemoEntity は同期。寸法は先に調べる（失敗は null で続ける）
        const assets =
          demo?.assets ?? (await loadDemoAssets(imageTool ?? defaultReceiptRuntime.imageTool));
        const result = createDemoEntity(
          demoEntityDeps({
            clock,
            assets,
            ...(files === undefined ? {} : { files }),
          }),
          { today: todayOf(clock) },
        );
        return respond(c, result, (entity) => c.json({ entity }, 201));
      } finally {
        creatingDemo = false;
      }
    })
    .get("/", (c) => c.json({ entities: registryRepository().listEntities() }, 200))
    .get("/archived", (c) => c.json({ entities: registryRepository().listArchivedEntities() }, 200))
    .post("/:entityId/archive", (c) => {
      const result = manageEntity(registryRepository(), c.req.param("entityId"), "archive");
      return respond(c, result, () => c.json({ ok: true }, 200));
    })
    .post("/:entityId/restore", (c) => {
      const result = manageEntity(registryRepository(), c.req.param("entityId"), "restore");
      return respond(c, result, () => c.json({ ok: true }, 200));
    })
    .delete("/:entityId/purge", validate("json", EntityPatch), (c) => {
      const id = c.req.param("entityId");
      if (hasActiveEntityRequests(id))
        return fail(c, {
          code: "VALIDATION",
          message: "処理中の操作があります。完了してから完全削除を再試行してください",
        });
      const result = manageEntity(registryRepository(), id, "purge", c.req.valid("json").name);
      return respond(c, result, () => c.json({ ok: true }, 200));
    })
    .post("/", validate("json", EntityCreate), (c) => {
      const result = createEntity(
        {
          registry: registryRepository(),
          openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
          ids,
          clock,
        },
        c.req.valid("json"),
      );
      return respond(c, result, (entity) => c.json({ entity }, 201));
    });
}

/** `/api/entities/:entityId`（テナントのミドルウェアの内側に置く） */
export const entityRoutes = new Hono<TenantEnv>().patch("/", validate("json", EntityPatch), (c) => {
  const { name } = c.req.valid("json");
  const result = renameEntity(
    { tenant: new DrizzleMasterRepository(c.var.db), registry: registryRepository() },
    c.var.entityId,
    name,
  );
  return respond(c, result, (entity) => c.json({ entity }, 200));
});
