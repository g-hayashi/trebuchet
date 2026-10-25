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
  FiscalYearParam,
  HomeUseAllocationInput,
  RentDetailsPut,
} from "@trebuchet/schema";
import { Hono } from "hono";
import {
  blueReturnDeps,
  closingSettingsDeps,
  commitAdjustmentDeps,
  type RouteOptions,
} from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下の青色申告決算書（003 US1。FR-001〜011）。個人の事業体だけ */
export function blueReturnRoutes({ clock }: RouteOptions) {
  return (
    new Hono<TenantEnv>()
      .get("/blue-return/:year", validate("param", FiscalYearParam), (c) => {
        const result = getBlueReturn(blueReturnDeps(c.var.db), {
          fiscalYear: c.req.valid("param").year,
        });
        return respond(c, result, (blueReturn) => c.json({ blueReturn }, 200));
      })
      // R14: BOM 付き UTF-8 の CSV。blankUnused は CSV だけが受ける（決算書の JSON は常に 0）
      .get(
        "/blue-return/:year/csv",
        validate("param", FiscalYearParam),
        validate("query", BlueReturnCsvQuery),
        (c) => {
          const { year } = c.req.valid("param");
          const result = getBlueReturn(blueReturnDeps(c.var.db), { fiscalYear: year });
          const { blankUnused } = c.req.valid("query");
          return respond(c, result, (blueReturn) =>
            c.text(blueReturnToCsv(blueReturn, { blankUnused }), 200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="blue-return-${year}.csv"`,
            }),
          );
        },
      )
      .get("/blue-return/:year/deduction-answers", validate("param", FiscalYearParam), (c) => {
        const result = getDeductionAnswers(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: c.req.valid("param").year,
        });
        return respond(c, result, (answers) => c.json(answers, 200));
      })
      .put(
        "/blue-return/:year/deduction-answers",
        validate("param", FiscalYearParam),
        validate("json", DeductionAnswersInput),
        (c) => {
          const result = saveDeductionAnswers(closingSettingsDeps(c.var.db, clock), {
            fiscalYear: c.req.valid("param").year,
            answers: c.req.valid("json"),
          });
          return respond(c, result, (saved) => c.json(saved, 200));
        },
      )
      // 決算のメモ（特別な事情・期首と前期末の差の説明。FR-027, FR-030）。締め済みでも保存できる
      .put(
        "/blue-return/:year/notes/:kind",
        validate("param", ClosingNoteParam),
        validate("json", ClosingNoteInput),
        (c) => {
          const { year, kind } = c.req.valid("param");
          const { body } = c.req.valid("json");
          const result = saveClosingNote(closingSettingsDeps(c.var.db, clock), {
            fiscalYear: year,
            kind,
            body,
          });
          return respond(c, result, (note) => c.json({ note }, 200));
        },
      )
      // ---- 家事按分・地代家賃の内訳・決算整理の仕訳の案（US2） ----
      .get("/blue-return/:year/home-use", validate("param", FiscalYearParam), (c) => {
        const result = listHomeUseAllocations(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: c.req.valid("param").year,
        });
        return respond(c, result, (allocations) => c.json(allocations, 200));
      })
      .put(
        "/blue-return/:year/home-use",
        validate("param", FiscalYearParam),
        validate("json", HomeUseAllocationInput),
        (c) => {
          const result = saveHomeUseAllocation(closingSettingsDeps(c.var.db, clock), {
            fiscalYear: c.req.valid("param").year,
            ...c.req.valid("json"),
          });
          return respond(c, result, (allocation) => c.json({ allocation }, 200));
        },
      )
      .get("/blue-return/:year/rent-details", validate("param", FiscalYearParam), (c) => {
        const result = getRentDetails(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: c.req.valid("param").year,
        });
        return respond(c, result, (rows) => c.json({ rows }, 200));
      })
      .put(
        "/blue-return/:year/rent-details",
        validate("param", FiscalYearParam),
        validate("json", RentDetailsPut),
        (c) => {
          const { rows } = c.req.valid("json");
          const result = saveRentDetails(closingSettingsDeps(c.var.db, clock), {
            fiscalYear: c.req.valid("param").year,
            rows,
          });
          return respond(c, result, (saved) => c.json({ rows: saved }, 200));
        },
      )
      .get("/blue-return/:year/adjustments", validate("param", FiscalYearParam), (c) => {
        const result = getAdjustmentProposals(blueReturnDeps(c.var.db), {
          fiscalYear: c.req.valid("param").year,
        });
        return respond(c, result, (proposals) => c.json({ proposals }, 200));
      })
      .post(
        "/blue-return/:year/adjustments",
        validate("param", FiscalYearParam),
        validate("json", AdjustmentCommitInput),
        (c) => {
          const { kind, sourceId, expected } = c.req.valid("json");
          const result = commitAdjustment(commitAdjustmentDeps(c.var.db, clock), {
            fiscalYear: c.req.valid("param").year,
            kind,
            sourceId,
            expected,
          });
          return respond(c, result, ({ journal, ref }) => c.json({ journal, ref }, 201));
        },
      )
  );
}
