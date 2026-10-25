import { DrizzleMasterRepository, openTenant } from "@trebuchet/db";
import { createEntity, renameEntity } from "@trebuchet/domain";
import { EntityCreate, EntityPatch } from "@trebuchet/schema";
import { Hono } from "hono";
import { ids, type RouteOptions, registryRepository } from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities`（テナントのミドルウェアの外） */
export function entitiesRoutes({ clock }: RouteOptions) {
  return new Hono()
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
