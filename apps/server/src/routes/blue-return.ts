import {
  blueReturnToCsv,
  getBlueReturn,
  getDeductionAnswers,
  saveDeductionAnswers,
} from "@trebuchet/domain";
import { BlueReturnCsvQuery, DeductionAnswersInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { blueReturnDeps, deductionAnswersDeps } from "../deps.ts";
import { fail, orThrow } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";
import { parseYear } from "./periods.ts";

/** `/api/entities/:entityId` の下の青色申告決算書（003 US1。FR-001〜011）。個人の事業体だけ */
export const blueReturnRoutes = new Hono<TenantEnv>()
  .get("/blue-return/:year", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = getBlueReturn(blueReturnDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json({ blueReturn: result.value }, 200);
  })
  // R14: BOM 付き UTF-8 の CSV。blankUnused は CSV だけが受ける（決算書の JSON は常に 0）
  .get("/blue-return/:year/csv", validate("query", BlueReturnCsvQuery), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = getBlueReturn(blueReturnDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    const { blankUnused } = c.req.valid("query");
    return c.text(blueReturnToCsv(result.value, { blankUnused }), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="blue-return-${year.value}.csv"`,
    });
  })
  .get("/blue-return/:year/deduction-answers", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = getDeductionAnswers(deductionAnswersDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 200);
  })
  .put("/blue-return/:year/deduction-answers", validate("json", DeductionAnswersInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const answers = c.req.valid("json");
    // 回答の保存と履歴を1つのトランザクションにする
    const view = c.var.db.transaction((tx) =>
      orThrow(saveDeductionAnswers(deductionAnswersDeps(tx), { fiscalYear: year.value, answers })),
    );
    return c.json(view, 200);
  });
