import { Hono } from "hono";
import { onError } from "./errors.ts";
import { blueReturnRoutes } from "./routes/blue-return.ts";
import { entitiesRoutes, entityRoutes } from "./routes/entities.ts";
import { fixedAssetRoutes } from "./routes/fixed-assets.ts";
import { importRoutes } from "./routes/imports.ts";
import { journalRoutes } from "./routes/journals.ts";
import { masterRoutes } from "./routes/masters.ts";
import { periodRoutes } from "./routes/periods.ts";
import { reportRoutes } from "./routes/reports.ts";
import { taxReturnRoutes } from "./routes/tax-return.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

const tenantRoutes = new Hono<TenantEnv>()
  .use(tenant)
  .route("/", entityRoutes)
  .route("/", masterRoutes)
  .route("/", periodRoutes)
  .route("/", journalRoutes)
  .route("/", reportRoutes)
  .route("/", importRoutes)
  .route("/", blueReturnRoutes)
  .route("/", fixedAssetRoutes)
  .route("/", taxReturnRoutes);

export const app = new Hono()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .route("/entities", entitiesRoutes)
  .route("/entities/:entityId", tenantRoutes);

app.onError(onError);

export type AppType = typeof app;
