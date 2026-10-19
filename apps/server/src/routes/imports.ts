import {
  commitFreeeImport,
  previewFreeeImport,
  proposeFreeeOpening,
  saveImportMappings,
} from "@trebuchet/domain";
import { ImportExpected, ImportMappingsPut, ImportOptions } from "@trebuchet/schema";
import { type Context, Hono } from "hono";
import { importDeps, reportDeps } from "../deps.ts";
import { errorBody, fail } from "../errors.ts";
import { readJsonField, readUpload, sha256Hex, uploadLimit } from "../lib/upload.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";
import { parseYear } from "./periods.ts";

/** multipart の file と options（JSON 文字列。なければ {}）を読み、ハッシュを計算する */
async function readImportForm(c: Context) {
  const upload = await readUpload(c);
  const options = await readJsonField(c, "options", ImportOptions, "{}");
  return { bytes: upload.bytes, fileName: upload.name, sha256: sha256Hex(upload.bytes), options };
}

/** `/api/entities/:entityId` の下の取込（002-freee-import、contracts/http-api.md） */
export const importRoutes = new Hono<TenantEnv>()
  .use("/imports/freee/*", uploadLimit)
  .use("/fiscal-periods/:year/opening-balances/freee-proposal", uploadLimit)
  .post("/imports/freee/preview", async (c) => {
    const form = await readImportForm(c);
    const result = previewFreeeImport(importDeps(c.var.db), form);
    if (!result.ok) return fail(c, result.error);
    return c.json({ preview: result.value }, 200);
  })
  .post("/imports/freee/commit", async (c) => {
    const form = await readImportForm(c);
    const expected = await readJsonField(c, "expected", ImportExpected);
    const result = commitFreeeImport(importDeps(c.var.db), { ...form, expected });
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 201);
  })
  .post("/fiscal-periods/:year/opening-balances/freee-proposal", async (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const upload = await readUpload(c);
    const result = proposeFreeeOpening(
      { uow: importDeps(c.var.db).uow, reports: reportDeps(c.var.db).reports },
      { bytes: upload.bytes, fiscalYear: year.value },
    );
    if (!result.ok) return fail(c, result.error);
    return c.json({ proposal: result.value }, 200);
  })
  .get("/imports", (c) => c.json({ batches: importDeps(c.var.db).imports.listBatches() }, 200))
  .get("/imports/:batchId", (c) => {
    const batchId = c.req.param("batchId");
    const { imports } = importDeps(c.var.db);
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
  .get("/import-mappings", (c) => {
    const { imports } = importDeps(c.var.db);
    return c.json(
      { accounts: imports.listAccountMappings(), taxes: imports.listTaxMappings() },
      200,
    );
  })
  .put("/import-mappings", validate("json", ImportMappingsPut), (c) => {
    const result = saveImportMappings(importDeps(c.var.db), c.req.valid("json"));
    // 対応先の検証（使用停止の科目・他の科目の補助科目など）は 422 VALIDATION（contracts/http-api.md の対応表）。
    // 入力の形の誤りは validate が 400 VALIDATION にする
    if (!result.ok) return c.json(errorBody(result.error), 422);
    return c.json(result.value, 200);
  });
