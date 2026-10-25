import { sValidator } from "@hono/standard-validator";
import { periodNotFound } from "@trebuchet/domain";
import type { ValidationTargets } from "hono";
import { fail, validationError } from "./errors.ts";

/** Zod などの Standard Schema で検証し、失敗したら 400 VALIDATION を返す */
type Schema = Parameters<typeof sValidator>[1];

export function validate<T extends keyof ValidationTargets, S extends Schema>(
  target: T,
  schema: S,
) {
  return sValidator(target, schema, (result, c) => {
    if (result.success) return;
    // パスの `:year`（`FiscalYearParam`）が 4 桁の数字でないときは、存在しない年度と同じ応答にする
    if (target === "param" && result.error.some((i) => i.path?.[0] === "year")) {
      return fail(c, periodNotFound(c.req.param("year") ?? ""));
    }
    return fail(c, validationError(result.error));
  });
}
