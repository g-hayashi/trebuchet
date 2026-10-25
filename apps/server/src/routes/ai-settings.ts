import { Hono } from "hono";
import type { RouteOptions } from "../deps.ts";

/**
 * `/api/settings` の下の AI の接続の設定（006。contracts/http-api.md §7。端末の設定）。
 * ルートは US5（T025）で足す。API キーは応答に出さない
 */
export function aiSettingsRoutes(_options: RouteOptions) {
  return new Hono();
}
