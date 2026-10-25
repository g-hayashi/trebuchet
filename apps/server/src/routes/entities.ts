import { DrizzleMasterRepository, openTenant } from "@trebuchet/db";
import { createEntity, renameEntity } from "@trebuchet/domain";
import { EntityCreate, EntityPatch } from "@trebuchet/schema";
import { Hono } from "hono";
import { clock, ids, registryRepository } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities`（テナントのミドルウェアの外） */
export const entitiesRoutes = new Hono()
  .get("/", (c) => c.json({ entities: registryRepository().listEntities() }, 200))
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
    if (!result.ok) return fail(c, result.error);
    return c.json({ entity: result.value }, 201);
  });

/** `/api/entities/:entityId`（テナントのミドルウェアの内側に置く） */
export const entityRoutes = new Hono<TenantEnv>().patch("/", validate("json", EntityPatch), (c) => {
  const { name } = c.req.valid("json");
  const result = renameEntity(
    { tenant: new DrizzleMasterRepository(c.var.db), registry: registryRepository() },
    c.var.entityId,
    name,
  );
  if (!result.ok) return fail(c, result.error);
  return c.json({ entity: result.value }, 200);
});
