import type { Clock } from "@trebuchet/domain";
import { Hono } from "hono";
import type { TenantEnv } from "../tenant.ts";

/**
 * `/api/entities/:entityId` の下の定期仕訳（005 US3）。
 * エンドポイントは US3 で足す。`clock` は「今日」（`todayOf`。R22）の元になる
 */
export function recurringRoutes(_options: { clock: Clock }) {
  return new Hono<TenantEnv>();
}
