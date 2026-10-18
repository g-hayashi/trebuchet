import { findRegisteredEntityId, openTenant, type TenantDb } from "@trebuchet/db";
import { createMiddleware } from "hono/factory";
import { DomainException } from "./errors.ts";

export type TenantEnv = {
  Variables: {
    entityId: string;
    db: TenantDb;
  };
};

/**
 * `/entities/:entityId/*` の前処理: registry に事業体があるかを確認し、その事業体の DB だけを開く（FR-002）。
 * 不正な形式の entityId も、存在しない事業体と同じく 404 にする。
 */
export const tenant = createMiddleware<TenantEnv>(async (c, next) => {
  const requested = c.req.param("entityId") ?? "";
  const entityId = findRegisteredEntityId(requested);
  if (entityId === undefined) {
    throw new DomainException({
      code: "ENTITY_NOT_FOUND",
      message: "事業体が見つかりません",
      details: { entityId: requested },
    });
  }
  c.set("entityId", entityId);
  c.set("db", openTenant(entityId));
  await next();
});
