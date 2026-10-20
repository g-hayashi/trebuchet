import {
  blueReturnToCsv,
  commitAdjustment,
  getAdjustmentProposals,
  getBlueReturn,
  getDeductionAnswers,
  getRentDetails,
  listHomeUseAllocations,
  saveClosingNote,
  saveDeductionAnswers,
  saveHomeUseAllocation,
  saveRentDetails,
} from "@trebuchet/domain";
import {
  AdjustmentCommitInput,
  BlueReturnCsvQuery,
  ClosingNoteInput,
  ClosingNoteParam,
  DeductionAnswersInput,
  HomeUseAllocationInput,
  RentDetailsPut,
} from "@trebuchet/schema";
import { Hono } from "hono";
import {
  blueReturnDeps,
  closingSettingsDeps,
  commitAdjustmentDeps,
  deductionAnswersDeps,
} from "../deps.ts";
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
  })
  // 決算のメモ（特別な事情・期首と前期末の差の説明。FR-027, FR-030）。締め済みでも保存できる
  .put(
    "/blue-return/:year/notes/:kind",
    validate("param", ClosingNoteParam),
    validate("json", ClosingNoteInput),
    (c) => {
      const year = parseYear(c.req.param("year"));
      if (!year.ok) return fail(c, year.error);
      const { kind } = c.req.valid("param");
      const { body } = c.req.valid("json");
      // メモの保存と履歴を1つのトランザクションにする
      const note = c.var.db.transaction((tx) =>
        orThrow(saveClosingNote(closingSettingsDeps(tx), { fiscalYear: year.value, kind, body })),
      );
      return c.json({ note }, 200);
    },
  )
  // ---- 家事按分・地代家賃の内訳・決算整理の仕訳の案（US2） ----
  .get("/blue-return/:year/home-use", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = listHomeUseAllocations(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
    });
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 200);
  })
  .put("/blue-return/:year/home-use", validate("json", HomeUseAllocationInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const input = c.req.valid("json");
    // 登録の保存と履歴を1つのトランザクションにする
    const allocation = c.var.db.transaction((tx) =>
      orThrow(saveHomeUseAllocation(closingSettingsDeps(tx), { fiscalYear: year.value, ...input })),
    );
    return c.json({ allocation }, 200);
  })
  .get("/blue-return/:year/rent-details", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = getRentDetails(closingSettingsDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json({ rows: result.value }, 200);
  })
  .put("/blue-return/:year/rent-details", validate("json", RentDetailsPut), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const { rows } = c.req.valid("json");
    const saved = c.var.db.transaction((tx) =>
      orThrow(saveRentDetails(closingSettingsDeps(tx), { fiscalYear: year.value, rows })),
    );
    return c.json({ rows: saved }, 200);
  })
  .get("/blue-return/:year/adjustments", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = getAdjustmentProposals(blueReturnDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json({ proposals: result.value }, 200);
  })
  .post("/blue-return/:year/adjustments", validate("json", AdjustmentCommitInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const { kind, sourceId, expected } = c.req.valid("json");
    const result = commitAdjustment(commitAdjustmentDeps(c.var.db), {
      fiscalYear: year.value,
      kind,
      sourceId,
      expected,
    });
    if (!result.ok) return fail(c, result.error);
    return c.json({ journal: result.value.journal, ref: result.value.ref }, 201);
  });
