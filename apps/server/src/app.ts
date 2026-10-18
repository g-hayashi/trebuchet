import { Hono } from "hono";

export const app = new Hono().basePath("/api").get("/health", (c) => c.json({ ok: true }));

export type AppType = typeof app;
