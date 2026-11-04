import { getHomeSummary } from "@trebuchet/domain";
import { Hono } from "hono";
import { homeDeps, type RouteOptions } from "../deps.ts";
import { todayOf } from "../lib/today.ts";
import type { TenantEnv } from "../tenant.ts";

/**
 * `/api/entities/:entityId` の下のホームの要約（011 US1。contracts/http-api.md §1、research R3）。
 * 今日は `todayOf(clock)`。項目ごとの失敗は応答の中の `{ status: "error", code }` で、応答全体は 200
 * （事業体がなければ tenant が 404 にする）
 */
export function homeRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>().get("/home", (c) =>
    c.json(getHomeSummary(homeDeps(c.var.db), todayOf(clock)), 200),
  );
}
