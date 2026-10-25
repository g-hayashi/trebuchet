import { existsSync } from "node:fs";
import {
  deleteFiledDocument,
  deleteTaxReturnMemo,
  listFiledDocuments,
  listTaxReturnMemos,
  saveFiledDocument,
  saveTaxReturnMemo,
} from "@trebuchet/domain";
import { FiledDocumentInput, TaxReturnMemoInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { closingSettingsDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";
import { parseYear } from "./periods.ts";

/**
 * ファイルがあるか（research R13）。ドメインは node:fs を使わないので、ここで確かめる。
 * 中身は読まない。パスがなければ false
 */
const fileExists = (filePath: string | null): boolean =>
  filePath !== null && filePath !== "" && existsSync(filePath);

/**
 * `/api/entities/:entityId` の下の申告の控えと提出書類の記録（003 US6。FR-033〜036）。個人の事業体だけ。
 * 決算書の計算には使わず、変更履歴（closing_audit_log）にも残さない
 */
export const taxReturnRoutes = new Hono<TenantEnv>()
  .get("/tax-return/:year/memos", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = listTaxReturnMemos(closingSettingsDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json(
      { memos: result.value.map((m) => ({ ...m, fileExists: fileExists(m.filePath) })) },
      200,
    );
  })
  .post("/tax-return/:year/memos", validate("json", TaxReturnMemoInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const input = c.req.valid("json");
    const result = saveTaxReturnMemo(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      ...input,
    });
    if (!result.ok) return fail(c, result.error);
    const memo = result.value;
    return c.json({ memo: { ...memo, fileExists: fileExists(memo.filePath) } }, 201);
  })
  .put("/tax-return/:year/memos/:memoId", validate("json", TaxReturnMemoInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const input = c.req.valid("json");
    const result = saveTaxReturnMemo(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      id: c.req.param("memoId"),
      ...input,
    });
    if (!result.ok) return fail(c, result.error);
    const memo = result.value;
    return c.json({ memo: { ...memo, fileExists: fileExists(memo.filePath) } }, 200);
  })
  .delete("/tax-return/:year/memos/:memoId", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = deleteTaxReturnMemo(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      id: c.req.param("memoId"),
    });
    if (!result.ok) return fail(c, result.error);
    return c.body(null, 204);
  })
  .get("/tax-return/:year/documents", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = listFiledDocuments(closingSettingsDeps(c.var.db), { fiscalYear: year.value });
    if (!result.ok) return fail(c, result.error);
    return c.json(
      { documents: result.value.map((d) => ({ ...d, fileExists: fileExists(d.filePath) })) },
      200,
    );
  })
  .post("/tax-return/:year/documents", validate("json", FiledDocumentInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const input = c.req.valid("json");
    const result = saveFiledDocument(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      ...input,
    });
    if (!result.ok) return fail(c, result.error);
    const document = result.value;
    return c.json({ document: { ...document, fileExists: fileExists(document.filePath) } }, 201);
  })
  .put("/tax-return/:year/documents/:documentId", validate("json", FiledDocumentInput), (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const input = c.req.valid("json");
    const result = saveFiledDocument(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      id: c.req.param("documentId"),
      ...input,
    });
    if (!result.ok) return fail(c, result.error);
    const document = result.value;
    return c.json({ document: { ...document, fileExists: fileExists(document.filePath) } }, 200);
  })
  .delete("/tax-return/:year/documents/:documentId", (c) => {
    const year = parseYear(c.req.param("year"));
    if (!year.ok) return fail(c, year.error);
    const result = deleteFiledDocument(closingSettingsDeps(c.var.db), {
      fiscalYear: year.value,
      id: c.req.param("documentId"),
    });
    if (!result.ok) return fail(c, result.error);
    return c.body(null, 204);
  });
