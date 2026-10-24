import { createMiddleware } from "hono/factory";
import { DomainException } from "../errors.ts";
import { allowedOrigins } from "../lib/origin.ts";
import type { GuardEnv } from "./host.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 検査 2: CSRF（FR-009）。`hono/csrf` は本文の形式（フォームの Content-Type）にしか検査を掛けず、
 * JSON の POST と本文なしの DELETE を通すので使わない。
 * GET・HEAD・OPTIONS 以外は、`Content-Type` によらず、`Origin` が許す一覧にあること。
 * `Origin` がなければ `Sec-Fetch-Site` が `same-origin` であること。どちらでもなければ 403 CSRF_REJECTED
 */
export const csrfCheck = createMiddleware<GuardEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  const ok =
    origin !== undefined
      ? allowedOrigins(c.var.remote).includes(origin)
      : c.req.header("sec-fetch-site") === "same-origin";
  if (!ok) {
    throw new DomainException({
      code: "CSRF_REJECTED",
      message: "別のサイトからの要求は受け付けません",
    });
  }
  await next();
});
