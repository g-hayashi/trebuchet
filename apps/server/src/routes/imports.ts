import { sha256Hex } from "@trebuchet/db";
import {
  commitFreeeImport,
  previewFreeeImport,
  proposeFreeeOpening,
  reconcileFreee,
  saveImportMappings,
  voidImportBatch,
} from "@trebuchet/domain";
import {
  FiscalYearParam,
  ImportExpected,
  ImportMappingsPut,
  ImportOptions,
  VoidImportInput,
} from "@trebuchet/schema";
import { type Context, Hono } from "hono";
import { importDeps, type RouteOptions, reportDeps } from "../deps.ts";
import { errorBody, fail, respond } from "../errors.ts";
import {
  readJsonField,
  readOptionalUpload,
  readUpload,
  uploadLimit,
  uploadLimitFor,
} from "../lib/upload.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** multipart の file と options（JSON 文字列。なければ {}）を読み、ハッシュを計算する */
async function readImportForm(c: Context) {
  const upload = await readUpload(c);
  const options = await readJsonField(c, "options", ImportOptions, "{}");
  return { bytes: upload.bytes, fileName: upload.name, sha256: sha256Hex(upload.bytes), options };
}

/** `/api/entities/:entityId` の下の取込（002-freee-import、contracts/http-api.md） */
export function importRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .use("/imports/freee/*", uploadLimit)
    .use("/fiscal-periods/:year/opening-balances/freee-proposal", uploadLimit)
    .use("/fiscal-periods/:year/reconcile/freee", uploadLimitFor(2))
    .post("/imports/freee/preview", async (c) => {
      const form = await readImportForm(c);
      const result = previewFreeeImport(importDeps(c.var.db, clock), form);
      return respond(c, result, (preview) => c.json({ preview }, 200));
    })
    .post("/imports/freee/commit", async (c) => {
      const form = await readImportForm(c);
      const expected = await readJsonField(c, "expected", ImportExpected);
      const result = commitFreeeImport(importDeps(c.var.db, clock), { ...form, expected });
      return respond(c, result, (committed) => c.json(committed, 201));
    })
    .post(
      "/fiscal-periods/:year/opening-balances/freee-proposal",
      validate("param", FiscalYearParam),
      async (c) => {
        const upload = await readUpload(c);
        const result = proposeFreeeOpening(
          { uow: importDeps(c.var.db, clock).uow, reports: reportDeps(c.var.db).reports },
          { bytes: upload.bytes, fiscalYear: c.req.valid("param").year },
        );
        return respond(c, result, (proposal) => c.json({ proposal }, 200));
      },
    )
    .post(
      "/fiscal-periods/:year/reconcile/freee",
      validate("param", FiscalYearParam),
      async (c) => {
        const upload = await readUpload(c);
        const journal = await readOptionalUpload(c, "journal");
        const result = reconcileFreee(
          { uow: importDeps(c.var.db, clock).uow, reports: reportDeps(c.var.db).reports },
          {
            bytes: upload.bytes,
            fiscalYear: c.req.valid("param").year,
            ...(journal === undefined ? {} : { journal: { bytes: journal.bytes } }),
          },
        );
        if (!result.ok) {
          // 元帳の取引日が会計期間の外（details.ledgerDate）は 422。ファイルの中身の誤り（行・列つき）は 400 VALIDATION のまま
          if (
            result.error.code === "VALIDATION" &&
            result.error.details?.ledgerDate !== undefined
          ) {
            return c.json(errorBody(result.error), 422);
          }
          return fail(c, result.error);
        }
        return c.json(result.value, 200);
      },
    )
    .get("/imports", (c) =>
      c.json({ batches: importDeps(c.var.db, clock).imports.listBatches() }, 200),
    )
    .get("/imports/:batchId", (c) => {
      const batchId = c.req.param("batchId");
      const { imports } = importDeps(c.var.db, clock);
      const batch = imports.getBatch(batchId);
      if (batch === undefined) {
        return fail(c, {
          code: "IMPORT_BATCH_NOT_FOUND",
          message: "取込の記録が見つかりません",
          details: { batchId },
        });
      }
      const journals = imports.journalsOfBatch(batchId).map(({ journal, ref }) => ({
        journalId: journal.id,
        journalNo: journal.journalNo,
        date: journal.date,
        freeeJournalId: ref.freeeJournalId,
        status: journal.status,
        version: journal.version,
      }));
      return c.json({ batch, journals }, 200);
    })
    .post("/imports/:batchId/void", validate("json", VoidImportInput), (c) => {
      const result = voidImportBatch(importDeps(c.var.db, clock), {
        batchId: c.req.param("batchId"),
        ...c.req.valid("json"),
      });
      return respond(c, result, (voided) => c.json(voided, 200));
    })
    .get("/import-mappings", (c) => {
      const { imports } = importDeps(c.var.db, clock);
      return c.json(
        { accounts: imports.listAccountMappings(), taxes: imports.listTaxMappings() },
        200,
      );
    })
    .put("/import-mappings", validate("json", ImportMappingsPut), (c) => {
      const result = saveImportMappings(importDeps(c.var.db, clock), c.req.valid("json"));
      // 対応先の検証（使用停止の科目・他の科目の補助科目など）は 422 VALIDATION（contracts/http-api.md の対応表）。
      // 入力の形の誤りは validate が 400 VALIDATION にする
      if (!result.ok) return c.json(errorBody(result.error), 422);
      return c.json(result.value, 200);
    });
}
