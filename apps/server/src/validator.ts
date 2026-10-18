import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import { errorBody } from "./errors.ts";

/** Zod などの Standard Schema で検証し、失敗したら 400 VALIDATION を返す */
type Schema = Parameters<typeof sValidator>[1];

export function validate<T extends keyof ValidationTargets, S extends Schema>(
  target: T,
  schema: S,
) {
  return sValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        errorBody({
          code: "VALIDATION",
          message: "入力が正しくありません",
          details: {
            issues: result.error.map((i) => ({
              path: (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)),
              message: i.message,
            })),
          },
        }),
        400,
      );
    }
  });
}
