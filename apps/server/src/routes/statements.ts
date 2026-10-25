import { Hono } from "hono";
import type { RouteOptions, SuggestionProviders } from "../deps.ts";
import type { TenantEnv } from "../tenant.ts";

/**
 * `/api/entities/:entityId` の下の明細の取込と AI 仕訳（006。contracts/http-api.md §2〜§6）。
 * ルートは各ストーリーのタスクで足す。AI の実物（`suggestion`）は US5（T025）で差す
 */
export function statementRoutes(_options: RouteOptions & { suggestion?: SuggestionProviders }) {
  return new Hono<TenantEnv>();
}
