import { Hono } from "hono";
import { onError } from "./errors.ts";
import { type TenantEnv, tenant } from "./tenant.ts";

const entityRoutes = new Hono<TenantEnv>().use(tenant);

export const app = new Hono()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .route("/entities/:entityId", entityRoutes);

app.onError(onError);

export type AppType = typeof app;
