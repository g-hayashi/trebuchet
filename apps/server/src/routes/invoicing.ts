import type { Clock } from "@trebuchet/domain";
import { Hono } from "hono";
import type { TenantEnv } from "../tenant.ts";

/**
 * `/api/entities/:entityId` の下の請求書（005 US1・US2・US4）。
 * エンドポイントは各ストーリーで足す。`clock` は「今日」（`todayOf`。R22）の元になる
 */
export function invoicingRoutes(_options: { clock: Clock }) {
  return new Hono<TenantEnv>();
}
