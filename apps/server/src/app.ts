import { Hono } from "hono";
import { onError } from "./errors.ts";
import { entitiesRoutes, entityRoutes } from "./routes/entities.ts";
import { journalRoutes } from "./routes/journals.ts";
import { masterRoutes } from "./routes/masters.ts";
import { periodRoutes } from "./routes/periods.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

const tenantRoutes = new Hono<TenantEnv>()
  .use(tenant)
  .route("/", entityRoutes)
  .route("/", masterRoutes)
  .route("/", periodRoutes)
  .route("/", journalRoutes);

export const app = new Hono()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .route("/entities", entitiesRoutes)
  .route("/entities/:entityId", tenantRoutes);

app.onError(onError);

export type AppType = typeof app;
