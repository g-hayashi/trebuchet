import { DrizzleMasterRepository, openTenant } from "@trebuchet/db";
import { createEntity, domainError } from "@trebuchet/domain";
import { EntityCreate, EntityPatch } from "@trebuchet/schema";
import { Hono } from "hono";
import { clock, ids, registryRepository } from "../deps.ts";
import { DomainException, fail } from "../errors.ts";
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
  const registry = registryRepository();
  // registry とテナントは別の DB のため、registry の更新をテナントのトランザクションの最後に行う。
  // registry の更新が失敗すればプロファイルの変更もロールバックされる
  const entity = new DrizzleMasterRepository(c.var.db).transaction((tx) => {
    const profile = tx.getProfile();
    if (profile === undefined) {
      throw new DomainException(domainError("ENTITY_NOT_FOUND", "事業体が見つかりません"));
    }
    const updated = { ...profile, name };
    tx.saveProfile(updated);
    registry.renameEntity(c.var.entityId, name);
    return updated;
  });
  return c.json({ entity }, 200);
});
