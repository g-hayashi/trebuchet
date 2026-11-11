import { findRegisteredEntityId, openTenant, type TenantDb } from "@trebuchet/db";
import { notFoundError } from "@trebuchet/domain";
import { createMiddleware } from "hono/factory";
import { DomainException } from "./errors.ts";

export type TenantEnv = {
  Variables: {
    entityId: string;
    db: TenantDb;
  };
};

const activeRequests = new Map<string, number>();
export const hasActiveEntityRequests = (id: string): boolean =>
  (activeRequests.get(id.toLowerCase()) ?? 0) > 0;

/**
 * `/entities/:entityId/*` の前処理: registry に事業体があるかを確認し、その事業体の DB だけを開く（FR-002）。
 * 不正な形式の entityId も、存在しない事業体と同じく 404 にする。
 */
export const tenant = createMiddleware<TenantEnv>(async (c, next) => {
  const requested = c.req.param("entityId") ?? "";
  const entityId = findRegisteredEntityId(requested);
  if (entityId === undefined) {
    throw new DomainException(notFoundError("ENTITY_NOT_FOUND", "事業体", { entityId: requested }));
  }
  c.set("entityId", entityId);
  c.set("db", openTenant(entityId));
  activeRequests.set(entityId, (activeRequests.get(entityId) ?? 0) + 1);
  try {
    await next();
  } finally {
    const remaining = (activeRequests.get(entityId) ?? 1) - 1;
    if (remaining === 0) activeRequests.delete(entityId);
    else activeRequests.set(entityId, remaining);
  }
});
